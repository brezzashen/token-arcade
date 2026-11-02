/** Reads owned local activity, quota points and per-response token usage through the read-only thread index. Response IDs prevent replay double counting; reasoning is a subset of output. speed.test.ts covers ownership, counters and window boundaries. */
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Window } from './quota.ts';

export type Turn = { id: string; threadId?: string; start: number; end: number; model: string; tier: string; complete: boolean };
export type CacheResponse = { responseId: string | null; threadId: string; turnId: string | null;
  at: number; model: string; input: number | null; cachedInput: number | null;
  output?: number | null; reasoningOutput?: number | null; cacheCreationInput?: number | null;
  /** Subset of cacheCreationInput written with the 1-hour TTL; null when the record does not split it. */
  cacheCreation1hInput?: number | null; source: string };
export type Point = Window & { at: number; source?: string };
export type Records = { turns: Turn[]; points: Point[]; diagnostics: Record<string, number>; anchors: string[];
  cacheResponses?: CacheResponse[] };
export const dateKey = (ms: number, timezone: string) => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(ms);

export function dayStart(now: number, timezone: string): number {
  const today = dateKey(now, timezone);
  let low = now - 30 * 3600_000, high = now;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (dateKey(middle, timezone) === today) high = middle; else low = middle;
  }
  return high;
}

function quotaPoints(raw: any, at: number): Point[] {
  if (!raw) return [];
  const bucket = raw.limit_id ?? 'codex';
  return ['primary', 'secondary'].flatMap(slot => {
    const w = raw[slot];
    if (!w || ![w.used_percent, w.window_minutes, w.resets_at].every(Number.isFinite)
      || w.used_percent < 0 || w.used_percent > 100) return [];
    return [{ key: `${bucket}:${slot}`, bucket, slot, used: w.used_percent,
      minutes: w.window_minutes, reset: w.resets_at * 1000, at }];
  });
}

export async function parseRollout(path: string, expectedId: string, accountId: string,
  start: number, now: number, result: Records): Promise<void> {
  let owner = false, seenMeta = false, firstModel = 'unknown', settingsTier = 'unknown';
  let current: Turn | undefined, lineNumber = 0, createdAt = -Infinity;
  const local = new Map<string, Turn>();
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const errors: Error[] = [];
  stream.on('error', error => { errors.push(error); lines.close(); });
  try {
    for await (const line of lines) {
      lineNumber++;
      let row: any;
      try { row = JSON.parse(line); } catch { result.diagnostics.malformedLines++; continue; }
      const p = row.payload, at = Date.parse(row.timestamp);
      if (!p || !Number.isFinite(at)) continue;
      if (row.type === 'session_meta' && !seenMeta) {
        seenMeta = true;
        owner = p.id === expectedId && p.creator_account_id === accountId;
        createdAt = Number.isFinite(Date.parse(p.timestamp)) ? Date.parse(p.timestamp) : at;
        if (!owner) { result.diagnostics.unownedFiles++; break; }
      }
      if (!owner || at > now) continue;
      if (row.type === 'event_msg' && p.type === 'thread_settings_applied') {
        firstModel = p.thread_settings?.model ?? firstModel;
        settingsTier = p.thread_settings?.service_tier ?? 'unknown';
      }
      if (row.type === 'event_msg' && p.type === 'task_started') {
        const id = p.turn_id;
        if (typeof id !== 'string') continue;
        if (Number.isFinite(p.started_at) && p.started_at * 1000 < createdAt - 1000) {
          current = undefined;
          result.diagnostics.inheritedCopies++;
          continue;
        }
        current = { id, threadId: expectedId, start: at, end: at, model: firstModel, tier: settingsTier, complete: false };
        local.set(id, current);
      }
      if (row.type === 'turn_context') {
        const t = local.get(p.turn_id);
        if (t) {
          t.model = p.model ?? 'unknown'; t.tier = p.service_tier ?? t.tier;
          current = t;
        }
      }
      if (row.type === 'token_usage_record' && at >= start && at >= createdAt) {
        const input = p.usage?.input_tokens, cachedInput = p.usage?.cached_input_tokens;
        const valid = [input, cachedInput].every(v => Number.isSafeInteger(v) && v >= 0) && cachedInput <= input;
        const output = p.usage?.output_tokens, reasoning = p.usage?.reasoning_output_tokens;
        const validOutput = Number.isSafeInteger(output) && output >= 0;
        const validReasoning = validOutput && Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= output;
        (result.cacheResponses ??= []).push({
          responseId: typeof p.response_id === 'string' && p.response_id ? p.response_id : null,
          threadId: expectedId, turnId: typeof p.turn_id === 'string' ? p.turn_id : null, at,
          model: local.get(p.turn_id)?.model ?? 'unknown', input: valid ? input : null,
          cachedInput: valid ? cachedInput : null, source: `${path}:${lineNumber}`,
          output: validOutput ? output : null, reasoningOutput: validReasoning ? reasoning : null,
        });
      }
      if (row.type === 'event_msg') {
        if (current) current.end = Math.max(current.end, at);
        if (['task_complete', 'turn_aborted', 'task_interrupted'].includes(p.type)) {
          const t = local.get(p.turn_id);
          if (t) { t.end = at; t.complete = true; }
          if (current?.id === p.turn_id) current = undefined;
        }
        if (p.type === 'token_count' && at >= start) {
          const points = quotaPoints(p.rate_limits, at).map(p => ({ ...p, source: `${path}:${lineNumber}` }));
          result.points.push(...points);
          if (points.length && result.anchors.length < 3) result.anchors.push(`${path}:${lineNumber}`);
        }
      }
    }
  } catch {
    result.diagnostics.unreadableFiles++;
  } finally { lines.close(); stream.destroy(); }
  if (errors.length) result.diagnostics.unreadableFiles++;
  if (!seenMeta) result.diagnostics.unownedFiles++;
  for (const t of local.values()) {
    if (t.end <= start || t.start >= now) continue;
    t.start = Math.max(t.start, start); t.end = Math.min(t.end, now);
    if (t.end > t.start) result.turns.push(t);
  }
}

export async function readRecords(home: string, accountId: string, start: number, now: number): Promise<Records> {
  const result: Records = { turns: [], points: [], anchors: [], diagnostics: {
    indexedFiles: 0, unreadableFiles: 0, unownedFiles: 0, malformedLines: 0, inheritedCopies: 0,
  } };
  const names = readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  if (!names.length) throw new Error('No supported Codex thread index found.');
  const db = new DatabaseSync(`${home}/${names[0]}`, { readOnly: true });
  let rows: any[];
  try {
    rows = db.prepare('SELECT id, rollout_path FROM threads WHERE updated_at >= ? AND creator_account_id = ?')
      .all(Math.floor(start / 1000), accountId);
    result.diagnostics.unownedFiles = Number((db.prepare('SELECT COUNT(*) AS n FROM threads WHERE updated_at >= ? AND creator_account_id IS NULL')
      .get(Math.floor(start / 1000)) as any).n);
  } finally { db.close(); }
  result.diagnostics.indexedFiles = rows.length;
  for (const row of rows) await parseRollout(row.rollout_path, row.id, accountId, start, now, result);
  const unique = new Map<string, Turn>();
  for (const t of result.turns) {
    const previous = unique.get(t.id);
    if (previous) result.diagnostics.inheritedCopies++;
    if (!previous || t.start < previous.start || (t.start === previous.start && t.end > previous.end)) unique.set(t.id, t);
  }
  result.turns = [...unique.values()];
  return result;
}
