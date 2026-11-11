/** Reads Claude response usage across projects, headless runs and subagents for passive range queries. Unlike claude-records.ts task-speed filtering, it clips by response time and merges split/cumulative message records once. Transcripts have no per-record account identity; claude-records.test.ts covers coverage and duplicates. */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { physicalLines } from './speed-records.ts';
import type { CacheResponse, Records, Turn } from './records.ts';

const counter = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function claudeResponse(message: any, at: number, threadId: string, turnId: string, source: string): CacheResponse {
  const u = message.usage ?? {}, read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
  const valid = [u.input_tokens, read, write].every(counter);
  const input = valid ? u.input_tokens + read + write : null;
  const reasoning = u.output_tokens_details?.thinking_tokens;
  const ttl = u.cache_creation, hour = ttl?.ephemeral_1h_input_tokens, minutes = ttl?.ephemeral_5m_input_tokens;
  // The TTL split prices each cache write exactly. Some responses report a split that sums below the total (about 1K tokens
  // on one response in 20,000, first seen 2026-11-10); that remainder is priced with the one-hour writes, the higher rate.
  // A record with no split, or one above the total, stays unknown unless nothing was written.
  const write1h = valid && counter(hour) && counter(minutes) && hour + minutes <= write ? write - minutes : valid && write === 0 ? 0 : null;
  return { responseId: typeof message.id === 'string' && message.id ? message.id : null, at, threadId, turnId,
    model: typeof message.model === 'string' ? message.model : 'unknown',
    input: counter(input) ? input : null, cachedInput: valid ? read : null, cacheCreationInput: valid ? write : null,
    cacheCreation1hInput: write1h,
    output: counter(u.output_tokens) ? u.output_tokens : null,
    reasoningOutput: counter(reasoning) && counter(u.output_tokens) && reasoning <= u.output_tokens ? reasoning : null, source };
}

export function mergeClaudeResponses(responses: CacheResponse[], diagnostics: Record<string, number>) {
  const unique = new Map<string, CacheResponse>();
  const conflicts = new Set<string>();
  for (const r of responses.sort((a, b) => a.at - b.at)) {
    const key = r.responseId ?? r.source, previous = unique.get(key);
    if (!previous) { unique.set(key, { ...r }); continue; }
    diagnostics.duplicateMessageRecords++;
    const full = (x: CacheResponse) => x.input !== null && x.cachedInput !== null && counter(x.output);
    if (!full(previous) && full(r) && !conflicts.has(key)) { unique.set(key, { ...r }); continue; }
    if (!full(r)) continue;
    if (previous.model !== r.model || previous.input !== r.input || previous.cachedInput !== r.cachedInput
      || previous.cacheCreationInput !== r.cacheCreationInput) {
      if (!conflicts.has(key)) diagnostics.conflictingMessages++;
      conflicts.add(key);
      unique.set(key, { ...previous, input: null, cachedInput: null, output: null }); continue;
    }
    if (r.output! > previous.output!) unique.set(key, { ...r });
    else if (r.output === previous.output && previous.reasoningOutput === null && r.reasoningOutput !== null) {
      unique.set(key, { ...previous, reasoningOutput: r.reasoningOutput });
    }
  }
  return [...unique.values()];
}

async function parseUsage(path: string, root: string, end: number, result: Records) {
  const threadId = relative(root, path), turns: Turn[] = [];
  let current: Turn | undefined, lastAt = 0;
  try {
    for await (const { line, number } of physicalLines(path)) {
      if (!line.trim()) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { result.diagnostics.malformedLines++; continue; }
      const at = Date.parse(r.timestamp);
      if (!Number.isFinite(at) || at > end) continue;
      lastAt = Math.max(lastAt, at);
      if (current && !current.complete) current.end = Math.max(current.end, at);
      const content = r.message?.content;
      const toolResult = Array.isArray(content) && content.some(b => b?.type === 'tool_result');
      const prompt = r.type === 'user' && !r.isMeta && !toolResult;
      if (prompt && (!current || current.complete)) {
        current = { id: `${threadId}:${number}`, threadId, start: at, end: at,
          model: 'unknown', tier: 'unknown', complete: false };
        turns.push(current);
      }
      if (r.type === 'assistant' && r.message?.model !== '<synthetic>' && r.message?.usage) {
        current ??= { id: `${threadId}:${number}`, threadId, start: at, end: at,
          model: 'unknown', tier: 'unknown', complete: false };
        if (!turns.includes(current)) turns.push(current);
        current.end = Math.max(current.end, at);
        const model = r.message.model ?? 'unknown';
        current.model = current.model === 'unknown' ? model : current.model === model ? model : 'mixed';
        current.tier = r.message.usage.speed ?? 'unknown';
        result.cacheResponses!.push(claudeResponse(r.message, at, threadId, current.id, `${path}:${number}`));
        if (r.message.stop_reason === 'end_turn') current.complete = true;
        else if (r.message.stop_reason === 'tool_use') current.complete = false;
      }
      if (current && r.type === 'system' && r.subtype === 'turn_duration') current.complete = true;
      if (current && prompt && typeof content === 'string' && content.startsWith('[Request interrupted by user')) {
        current.complete = true;
      }
    }
  } catch { result.diagnostics.unreadableFiles++; }
  if (current && !current.complete) current.end = Math.max(current.end, lastAt);
  result.turns.push(...turns.filter(t => t.end > t.start));
}

export async function readClaudeUsageRecords(configDir: string, start: number, end: number): Promise<Records> {
  const root = join(configDir, 'projects');
  const result: Records = { turns: [], points: [], anchors: [], cacheResponses: [], diagnostics: {
    indexedFiles: 0, subagentFiles: 0, unreadableFiles: 0, unownedFiles: 0, malformedLines: 0,
    duplicateMessageRecords: 0, conflictingMessages: 0,
  } };
  const files: string[] = [];
  try {
    for (const project of readdirSync(root)) {
      if (project.includes('antigravity-orca-bridge')) continue;
      const dir = join(root, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        const path = join(dir, name), stat = statSync(path);
        if (stat.isFile() && name.endsWith('.jsonl') && stat.mtimeMs >= start) files.push(path);
        if (!stat.isDirectory()) continue;
        const subagents = join(path, 'subagents');
        try {
          for (const child of readdirSync(subagents)) {
            const file = join(subagents, child), stat = statSync(file);
            if (child.endsWith('.jsonl') && stat.isFile() && stat.mtimeMs >= start) {
              files.push(file); result.diagnostics.subagentFiles++;
            }
          }
        } catch (error: any) { if (error.code !== 'ENOENT') result.diagnostics.unreadableFiles++; }
      }
    }
  } catch { result.diagnostics.unreadableFiles++; }
  result.diagnostics.indexedFiles = files.length;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (cursor < files.length) await parseUsage(files[cursor++], root, end, result);
  }));
  result.cacheResponses = mergeClaudeResponses(result.cacheResponses!, result.diagnostics)
    .filter(r => r.at >= start && r.at <= end);
  result.turns = result.turns.filter(t => t.end > start && t.start < end)
    .map(t => ({ ...t, start: Math.max(start, t.start), end: Math.min(end, t.end) }));
  return result;
}
