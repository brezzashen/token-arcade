/** Aggregates per-response cache metadata for range.ts/cache.ts and shares usage-window deduplication with token-report.ts. Conflicting counters remain unavailable without changing source records; speed.test.ts covers missing usage, duplicates and interval clipping. */
import type { CacheResponse, Records } from './records.ts';

function summarize(responses: CacheResponse[], turns: Records['turns']) {
  const valid = responses.filter(r => r.responseId !== null && r.input !== null && r.cachedInput !== null);
  const inputTokens = valid.reduce((n, r) => n + r.input!, 0);
  const cachedInputTokens = valid.reduce((n, r) => n + r.cachedInput!, 0);
  const positive = valid.filter(r => r.input! > 0);
  const withCache = positive.filter(r => r.cachedInput! > 0).length;
  const observedTurns = new Set(responses.map(r => r.turnId));
  const turnsWithoutUsage = turns.filter(t => !observedTurns.has(t.id)).length;
  const invalidResponses = responses.length - valid.length;
  return {
    status: inputTokens === 0 ? 'unavailable' : invalidResponses || turnsWithoutUsage ? 'partial' : 'observed',
    reason: inputTokens === 0 ? valid.length ? 'zero_input_tokens' : 'missing_or_invalid_usage' : null,
    inputTokens, cachedInputTokens, uncachedInputTokens: inputTokens - cachedInputTokens,
    tokenHitPercent: inputTokens > 0 ? cachedInputTokens / inputTokens * 100 : null,
    responses: responses.length, validResponses: valid.length, invalidResponses, turnsWithoutUsage,
    responsesWithCache: withCache, positiveInputResponses: positive.length,
    responseHitPercent: positive.length ? withCache / positive.length * 100 : null,
    firstResponseAt: responses.length ? new Date(responses[0].at).toISOString() : null,
    lastResponseAt: responses.length ? new Date(responses[responses.length - 1].at).toISOString() : null,
    evidence: responses.slice(-3).map(r => r.source),
  };
}

export function usageWindow(records: Records, start: number, end: number, threadId?: string) {
  const unique = new Map<string, CacheResponse>();
  let duplicateResponses = 0;
  for (const r of records.cacheResponses ?? []) {
    if (r.at < start || r.at > end || (threadId && r.threadId !== threadId)) continue;
    const key = r.responseId ?? r.source, previous = unique.get(key);
    if (previous) {
      duplicateResponses++;
      if (previous.input !== r.input || previous.cachedInput !== r.cachedInput) {
        unique.set(key, { ...previous, input: null, cachedInput: null });
      }
      const merged = unique.get(key)!;
      if (previous.output !== r.output) merged.output = null;
      if (previous.reasoningOutput !== r.reasoningOutput) merged.reasoningOutput = null;
      if (previous.cacheCreationInput !== r.cacheCreationInput) merged.cacheCreationInput = null;
    } else unique.set(key, { ...r });
  }
  const responses = [...unique.values()].sort((a, b) => a.at - b.at);
  const turns = records.turns.filter(t => t.end >= start && t.start < end && (!threadId || t.threadId === threadId));
  return { responses, turns, duplicateResponses };
}

export function cacheWindow(records: Records, start: number, end: number, threadId?: string) {
  const { responses, turns, duplicateResponses } = usageWindow(records, start, end, threadId);
  const grouped = (key: 'threadId' | 'model') => {
    const keys = new Set([...responses.map(r => r[key]), ...turns.map(t => t[key]).filter((s): s is string => Boolean(s))]);
    return [...keys].map(value => ({ [key]: value,
      ...summarize(responses.filter(r => r[key] === value), turns.filter(t => t[key] === value)),
    })).sort((a, b) => b.inputTokens - a.inputTokens);
  };
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    ...summarize(responses, turns), duplicateResponses, byModel: grouped('model'), byThread: grouped('threadId') };
}

export function buildCacheReport(records: Records, start: number, end: number, currentThreadId?: string) {
  return {
    basis: 'sum(cached_input_tokens) / sum(input_tokens) from deduplicated token_usage_record.usage',
    scope: 'Locally recorded current-account responses, including subagents; no quota-cycle restriction.',
    samples: [
      { id: 'last_hour', ...cacheWindow(records, Math.max(start, end - 3600_000), end) },
      { id: 'last_three_hours', ...cacheWindow(records, Math.max(start, end - 3 * 3600_000), end) },
      { id: 'last_five_hours', ...cacheWindow(records, Math.max(start, end - 5 * 3600_000), end) },
      { id: 'today', ...cacheWindow(records, start, end) },
    ],
    currentThread: currentThreadId ? { threadId: currentThreadId, ...cacheWindow(records, start, end, currentThreadId) } : null,
    diagnostics: records.diagnostics,
    limitations: [
      'Ratios describe valid recorded responses only; missing usage is unavailable, never a cache miss.',
      'Turns without usage can be in flight or recorded by older clients; their missing response count is unknown.',
      'Token hit rate is weighted by input tokens; response hit rate only means some input was cached.',
      'Other devices and unreadable or unowned files are excluded. No savings or quota attribution is inferred.',
    ],
  };
}
