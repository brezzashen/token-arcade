/** Passive Antigravity telemetry and read-only quota/billing for ag1 (subscription) and ag2 (Vertex AI). */
import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { decodeWire, nested, number, readConversationModels } from './antigravity-speed.ts';
import { readAntigravityQuota } from './antigravity-quota.ts';
import { geminiSubscriptionPlan, geminiVertexPlan, vertexStepCostUsd } from './subscription.ts';

const hour = 3600_000;
type Usage = { at: number; input: number; cached: number; output: number; model: string | null };
type StepUsage = Usage & { thinking: number | null; provider: number | null };
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function sgtMonthStart(now: number) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit' }).format(now);
  return Date.parse(`${parts}-01T00:00:00+08:00`);
}

/** One snapshot per step; streaming revisions replace earlier records, never add to them. */
export function parseAntigravityStep(row: any): Usage | null {
  if (row?.type !== 'PLANNER_RESPONSE' || row.status !== 'DONE') return null;
  const at = Date.parse(row.created_at);
  if (!Number.isFinite(at) || ![row.input_tokens, row.cache_read_tokens, row.output_tokens].every(counter)) return null;
  // Antigravity reports ordinary input and cached input separately. Output already includes thinking.
  return { at, input: row.input_tokens + row.cache_read_tokens, cached: row.cache_read_tokens,
    output: row.output_tokens, model: typeof row.model === 'string' && row.model.trim() ? row.model : null };
}

type DbStepMeta = { at: number; model: string | null; provider: number | null; in?: number; cached?: number; out?: number; think?: number; resp?: number };

function readStepMetadata(dbPath: string): { meta: Map<number, DbStepMeta>; ok: boolean } {
  const meta = new Map<number, DbStepMeta>();
  if (!existsSync(dbPath)) return { meta, ok: false };
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 } as any);
    try {
      const models = readConversationModels(db);
      for (const row of db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3').all() as { idx: number; metadata: Uint8Array }[]) {
        try {
          const wire = decodeWire(row.metadata), usage = nested(wire, 9), enumId = number(usage, 1);
          const created = nested(wire, 1), sec = number(created, 1), nanos = number(created, 2) ?? 0;
          const at = sec === undefined || nanos >= 1e9 ? NaN : Math.floor(sec * 1000 + nanos / 1e6);
          meta.set(row.idx, { at, model: enumId === undefined ? null : models.get(enumId) ?? null,
            provider: number(usage, 6) ?? null, in: number(usage, 2), cached: number(usage, 5),
            out: number(usage, 3), think: number(usage, 9), resp: number(usage, 10) });
        } catch { /* Ignore unreadable step metadata. */ }
      }
      return { meta, ok: true };
    } finally { db.close(); }
  } catch { return { meta, ok: false }; }
}

const matchesAlias = (alias: 'ag1' | 'ag2', provider: number | null) =>
  alias === 'ag2' ? provider !== null && [3, 26, 31].includes(provider)
    : provider === null || [24, 30].includes(provider);

export async function readAntigravityReport(home = homedir(), now = Date.now(),
  options: { alias?: 'ag1' | 'ag2' | 'gm' | 'gm2'; quotaReader?: (home: string) => Promise<any> } = {}) {
  const rawAlias = options.alias ?? 'ag1';
  const alias: 'ag1' | 'ag2' = rawAlias === 'ag2' || rawAlias === 'gm2' ? 'ag2' : 'ag1';
  const isVertex = alias === 'ag2';
  const plan = isVertex ? geminiVertexPlan : geminiSubscriptionPlan;
  const label = isVertex ? 'ag2 · vertex' : 'ag1 · ultra';
  const brain = join(home, '.gemini/antigravity-cli/brain');
  const conversations = join(home, '.gemini/antigravity-cli/conversations');
  const quotaPromise = isVertex ? Promise.resolve({ status: 'unavailable', plan, windows: [] })
    : options.quotaReader ? options.quotaReader(home)
    : existsSync(join(home, '.local/bin/agy')) ? readAntigravityQuota(home, now)
    : Promise.resolve({ status: 'unavailable', plan, windows: [] });
  const records: StepUsage[] = [];
  let gaps = false;
  let missing = 0;
  let available = true;
  let directories;
  try { directories = await readdir(brain, { withFileTypes: true }); }
  catch { directories = []; available = false; }
  const dbFiles = await readdir(conversations).then(names => names.filter(name => name.endsWith('.db'))).catch(() => [] as string[]);
  if (dbFiles.length) available = true;
  const monthStart = sgtMonthStart(now);
  const scanSince = isVertex ? Math.min(monthStart, now - 7 * 24 * hour) : now - 7 * 24 * hour;
  const seenConversations = new Set<string>();

  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    // Read only the canonical transcript; full transcripts and chunks duplicate these steps.
    const path = join(brain, directory.name, '.system_generated/logs/transcript.jsonl');
    const dbPath = join(conversations, `${directory.name}.db`);
    try {
      if ((await stat(path)).mtimeMs < scanSince) continue;
      const steps = new Map<number, any>();
      const input = createReadStream(path, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            if (row.type === 'PLANNER_RESPONSE' && Number.isSafeInteger(row.step_index)) steps.set(row.step_index, row);
          } catch { gaps = true; }
        }
      } finally { lines.close(); input.destroy(); }
      const { meta: stepMeta, ok: dbOk } = readStepMetadata(dbPath);
      if (dbOk) seenConversations.add(directory.name);
      else if (existsSync(dbPath)) { gaps = true; if (isVertex) continue; }
      for (const row of steps.values()) {
        const at = Date.parse(row.created_at);
        if (at < scanSince || at > now || !Number.isFinite(at)) continue;
        const meta = stepMeta.get(row.step_index);
        const provider = meta?.provider ?? null;
        if (!matchesAlias(alias, provider)) continue;
        const usage = parseAntigravityStep(row);
        if (usage) {
          const hasThinkingText = typeof row.thinking === 'string' && row.thinking.trim().length > 0;
          const thinking = counter(row.thinking_tokens) && row.thinking_tokens <= usage.output ? row.thinking_tokens
            : meta && meta.out === usage.output
              ? (meta.think !== undefined && meta.think + (meta.resp ?? 0) === usage.output ? meta.think
                : !hasThinkingText && meta.resp === usage.output ? 0 : null)
              : null;
          records.push({ ...usage, model: usage.model ?? meta?.model ?? null, thinking, provider });
        } else if (row.status === 'DONE' && at >= now - 24 * hour) missing++;
      }
    } catch (error: any) { if (error.code !== 'ENOENT') gaps = true; }
  }

  for (const file of dbFiles) {
    const id = basename(file, '.db');
    if (seenConversations.has(id)) continue;
    const dbPath = join(conversations, file);
    try {
      const wal = await stat(dbPath + '-wal').catch(() => null);
      if (Math.max((await stat(dbPath)).mtimeMs, wal?.mtimeMs ?? 0) < scanSince) continue;
      const { meta: stepMeta } = readStepMetadata(dbPath);
      for (const meta of stepMeta.values()) {
        if (!Number.isFinite(meta.at) || meta.at < scanSince || meta.at > now || !matchesAlias(alias, meta.provider)) continue;
        if (meta.in !== undefined && meta.out !== undefined) {
          const cached = meta.cached ?? 0;
          const thinking = meta.think !== undefined && meta.think + (meta.resp ?? 0) === meta.out ? meta.think
            : meta.think === undefined && meta.resp === meta.out ? 0 : null;
          records.push({ at: meta.at, input: meta.in + cached, cached, output: meta.out, model: meta.model, thinking, provider: meta.provider });
        }
      }
    } catch { /* Ignore unreadable DB. */ }
  }

  const aggregate = (start: number, end: number, model?: string) => {
    const selected = records.filter(row => row.at >= start && row.at <= end && (model === undefined || row.model === model));
    const sum = (key: 'input' | 'cached' | 'output') => selected.reduce((total, row) => total + row[key], 0);
    const hasUsage = selected.length > 0;
    const input = hasUsage ? sum('input') : null;
    const cached = hasUsage ? sum('cached') : null;
    const output = hasUsage ? sum('output') : null;
    const total = input === null || output === null ? null : input + output;
    const reasoning = hasUsage && selected.every(row => row.thinking !== null)
      ? selected.reduce((total, row) => total + row.thinking!, 0) : null;
    const longSelected = selected.filter(row => row.input > 200_000);
    const longInput = longSelected.reduce((n, row) => n + row.input, 0);
    const longCached = longSelected.reduce((n, row) => n + row.cached, 0);
    const longOutput = longSelected.reduce((n, row) => n + row.output, 0);
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      status: !available || !hasUsage ? 'unavailable' : gaps || missing ? 'partial' : 'observed',
      inputTokens: input, cachedInputTokens: cached, uncachedInputTokens: input === null || cached === null ? null : input - cached,
      outputTokens: output, totalTokens: total, reasoningOutputTokens: reasoning, cacheCreationInputTokens: hasUsage ? 0 : null,
      cacheCreation1hInputTokens: hasUsage ? 0 : null,
      longContext: hasUsage ? { thresholdInputTokens: 200_000, inputTokens: longInput, cachedInputTokens: longCached,
        cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, outputTokens: longOutput } : null,
      tokensPerWallClockHour: total === null ? null : total / ((end - start) / hour),
      tokensPerActiveHour: null, validResponses: selected.length, turnsWithoutUsage: missing, recordGaps: gaps };
  };

  const ids = ['last_hour', 'last_three_hours', 'last_five_hours', 'last_24_hours'];
  const samples = [1, 3, 5, 24].map((hours, i) => ({ id: ids[i], ...aggregate(now - hours * hour, now) }));
  const recentRecords = records.filter(row => row.at >= now - 24 * hour);
  const models = [...new Set(recentRecords.flatMap(row => row.model === null ? [] : [row.model]))];
  const quota = await quotaPromise;
  const windows = (quota.windows ?? []).map((win: any) => {
    const reset = Date.parse(win.resetsAt);
    const minutes = win.windowMinutes;
    if (!Number.isFinite(reset) || typeof minutes !== 'number' || win.modelScope) return win;
    const cycleStart = reset - minutes * 60_000;
    const cycleUsage = aggregate(cycleStart, now);
    const cycleModels = [...new Set(records.filter(row => row.at >= cycleStart && row.at <= now)
      .flatMap(row => row.model === null ? [] : [row.model]))];
    const used = win.usedPercent;
    const perPoint = cycleUsage.totalTokens !== null && typeof used === 'number' && used > 0 ? cycleUsage.totalTokens / used : null;
    return { ...win, cycleTokens: { ...cycleUsage,
      byModel: cycleModels.map(model => ({ model, ...aggregate(cycleStart, now, model) })),
      tokensPerQuotaPercentagePoint: perPoint,
      projectedTokensPerFullWindow: perPoint === null ? null : perPoint * 100 } };
  });

  const sumBilling = (since: number) => {
    const selected = records.filter(row => row.at >= since && row.at <= now);
    let cost = 0;
    let complete = true;
    for (const row of selected) {
      const stepCost = vertexStepCostUsd(row.model, row.input - row.cached, row.cached, row.output);
      if (stepCost === null) complete = false;
      else cost += stepCost;
    }
    return { count: selected.length, usd: !available ? null : selected.length === 0 ? 0 : complete ? cost : null };
  };
  const mtd = isVertex ? sumBilling(monthStart) : null;
  const day = isVertex ? sumBilling(now - 24 * hour) : null;
  const billing = isVertex ? {
    costUsd: mtd!.usd, dayCostUsd: day!.usd, currency: 'USD',
    periodStart: new Date(monthStart).toISOString(), periodEnd: new Date(now).toISOString(),
    project: process.env.TOKEN_VERTEX_PROJECT ?? null, validResponses: mtd!.count,
  } : null;

  return { account: { label }, capturedAt: new Date(now).toISOString(),
    quota: { ...quota, plan, windows }, billing,
    tokens: { samples, byModel: models.map(model => ({ model, ...aggregate(now - 24 * hour, now, model) })) },
    cache: { samples: samples.map(row => ({ id: row.id, tokenHitPercent:
      row.inputTokens !== null && row.inputTokens > 0 && row.cachedInputTokens !== null
        ? row.cachedInputTokens / row.inputTokens * 100 : null })) },
    telemetryError: !available || gaps,
    dashboard: { text: isVertex
      ? 'Vertex AI 按量计费；按本机 Vertex 对话记录核算美元费用。'
      : 'Google AI Ultra 订阅；服务端 5 小时与周限额独立统计。' } };
}
