/** Reports observed token consumption and hourly burn for range.ts using shared response deduplication and union activity. Quota samples use their actual intervals; tokens never become a fixed subscription allowance. speed.test.ts covers counter conservation, partial usage and reset clipping. */
import type { Records } from './records.ts';
import { usageWindow } from './cache-report.ts';
import { unionHours } from './forecast.ts';
import type { windowForecast } from './forecast.ts';

/** OpenAI bills a whole request at long-context rates above this many input tokens (gpt-6.1-sol pricing, checked 2026-10-07). */
export const LONG_CONTEXT_INPUT_TOKENS = 272_000;
type Usage = { input: number | null; cachedInput: number | null; output?: number | null;
  cacheCreationInput?: number | null; cacheCreation1hInput?: number | null };

/** Sums the price-relevant counters; an undefined counter (a source without it) is 0, a null one makes the sum unknown. */
function priceCounters(responses: Usage[]) {
  const sum = (pick: (r: Usage) => number | null | undefined) => responses.some(r => pick(r) === null) ? null
    : responses.reduce((n, r) => n + (pick(r) ?? 0), 0);
  return { responses: responses.length, inputTokens: sum(r => r.input), cachedInputTokens: sum(r => r.cachedInput),
    cacheCreationInputTokens: sum(r => r.cacheCreationInput), cacheCreation1hInputTokens: sum(r => r.cacheCreation1hInput),
    outputTokens: sum(r => r.output) };
}

export function tokenWindow(records: Records, start: number, end: number, threadId?: string) {
  const { responses, turns, duplicateResponses } = usageWindow(records, start, end, threadId);
  const valid = responses.filter(r => r.responseId !== null && r.input !== null && r.cachedInput !== null
    && Number.isSafeInteger(r.output) && r.output! >= 0);
  const inputTokens = valid.length ? valid.reduce((n, r) => n + r.input!, 0) : null;
  const cachedInputTokens = valid.length ? valid.reduce((n, r) => n + r.cachedInput!, 0) : null;
  const outputTokens = valid.length ? valid.reduce((n, r) => n + r.output!, 0) : null;
  const cacheCreationInputTokens = valid.length && valid.every(r => r.cacheCreationInput !== null)
    ? valid.reduce((n, r) => n + (r.cacheCreationInput ?? 0), 0) : null;
  const cacheCreation1hInputTokens = valid.length ? priceCounters(valid).cacheCreation1hInputTokens : null;
  const totalTokens = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
  const reasoning = valid.filter(r => Number.isSafeInteger(r.reasoningOutput)
    && r.reasoningOutput! >= 0 && r.reasoningOutput! <= r.output!);
  const reasoningOutputTokens = reasoning.length === valid.length && valid.length
    ? reasoning.reduce((n, r) => n + r.reasoningOutput!, 0) : null;
  const observedTurns = new Set(responses.map(r => `${r.threadId}:${r.turnId}`));
  const turnsWithoutUsage = turns.filter(t => !observedTurns.has(`${t.threadId}:${t.id}`)).length;
  const invalidResponses = responses.length - valid.length;
  const recordGaps = ['unreadableFiles', 'unownedFiles', 'malformedLines']
    .some(key => (records.diagnostics[key] ?? 0) > 0);
  const activeHours = unionHours(turns, start, end), wallClockHours = (end - start) / 3600_000;
  const rate = (hours: number) => totalTokens !== null && hours > 0 ? totalTokens / hours : null;
  return {
    start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    status: !valid.length ? 'unavailable' : invalidResponses || turnsWithoutUsage || recordGaps ? 'partial' : 'observed',
    reason: !valid.length ? 'missing_or_invalid_usage' : null,
    inputTokens, cachedInputTokens,
    cacheCreationInputTokens, cacheCreation1hInputTokens,
    // Requests above the long-context boundary, already included in the totals above.
    longContext: { thresholdInputTokens: LONG_CONTEXT_INPUT_TOKENS,
      ...priceCounters(valid.filter(r => r.input! > LONG_CONTEXT_INPUT_TOKENS)) },
    plainInputTokens: inputTokens === null || cachedInputTokens === null || cacheCreationInputTokens === null
      ? null : inputTokens - cachedInputTokens - cacheCreationInputTokens,
    uncachedInputTokens: inputTokens === null || cachedInputTokens === null ? null : inputTokens - cachedInputTokens,
    outputTokens, reasoningOutputTokens,
    visibleOutputTokens: outputTokens === null || reasoningOutputTokens === null ? null : outputTokens - reasoningOutputTokens,
    totalTokens, responses: responses.length, validResponses: valid.length,
    invalidResponses, duplicateResponses, turnsWithoutUsage, recordGaps,
    reasoningResponses: reasoning.length, activeHours, wallClockHours,
    tokensPerWallClockHour: rate(wallClockHours), tokensPerActiveHour: rate(activeHours),
    firstResponseAt: valid.length ? new Date(valid[0].at).toISOString() : null,
    lastResponseAt: valid.length ? new Date(valid.at(-1)!.at).toISOString() : null,
    evidence: valid.slice(-3).map(r => r.source),
  };
}

/**
 * Cumulative consumption since a quota window last reset, from `resetsAt - windowMinutes` to capture.
 * The window restarts at zero, so its used percentage is an observed delta over exactly this interval.
 * `model` restricts a server model-scoped window to matching recorded model IDs.
 */
export function cycleTokenConsumption(records: Records, window: { resetsAt: number; windowMinutes: number; usedPercent: number },
  end: number, model?: (id: string) => boolean) {
  const start = Math.min(end, window.resetsAt - window.windowMinutes * 60_000);
  const scoped = model ? { ...records, turns: records.turns.filter(t => model(t.model)),
    cacheResponses: records.cacheResponses?.filter(r => model(r.model)) } : records;
  const tokens = tokenWindow(scoped, start, end), used = window.usedPercent;
  return { ...tokens, intervalBasis: 'resetsAt minus windowMinutes, to capture', quotaPercentagePoints: used,
    tokensPerQuotaPercentagePoint: tokens.totalTokens !== null && used > 0 ? tokens.totalTokens / used : null,
    // Linear extrapolation of this cycle's observed mix to 100%; not a published allowance.
    projectedTokensPerFullWindow: tokens.totalTokens !== null && used > 0 ? tokens.totalTokens / used * 100 : null,
    quotaPercentagePointsPerWallClockHour: tokens.wallClockHours > 0 ? used / tokens.wallClockHours : null,
    quotaPercentagePointsPerActiveHour: tokens.activeHours > 0 ? used / tokens.activeHours : null };
}

export function quotaTokenConsumption(records: Records, window: ReturnType<typeof windowForecast>) {
  if (!('sampleStart' in window) || !('sampleEnd' in window)) return null;
  const tokens = tokenWindow(records, Date.parse(window.sampleStart!), Date.parse(window.sampleEnd!));
  const delta = window.samplePercentagePoints;
  return { ...tokens, quotaPercentagePoints: delta,
    tokensPerQuotaPercentagePoint: tokens.totalTokens !== null && delta! > 0 ? tokens.totalTokens / delta! : null,
    quotaPercentagePointsPerWallClockHour: tokens.wallClockHours > 0 ? delta! / tokens.wallClockHours : null,
    quotaPercentagePointsPerActiveHour: tokens.activeHours > 0 ? delta! / tokens.activeHours : null,
  };
}

export function buildTokenReport(records: Records, start: number, end: number, currentThreadId?: string) {
  const { responses } = usageWindow(records, start, end);
  return {
    basis: 'Deduplicated token_usage_record.usage; total = input_tokens + output_tokens. Cached input and reasoning output are subsets.',
    scope: 'Locally recorded current-account responses across all projects and owned subagents; current local day only.',
    samples: [
      { id: 'last_hour', ...tokenWindow(records, Math.max(start, end - 3600_000), end) },
      { id: 'last_three_hours', ...tokenWindow(records, Math.max(start, end - 3 * 3600_000), end) },
      { id: 'last_five_hours', ...tokenWindow(records, Math.max(start, end - 5 * 3600_000), end) },
      { id: 'today', ...tokenWindow(records, start, end) },
    ],
    currentThread: currentThreadId ? { threadId: currentThreadId, ...tokenWindow(records, start, end, currentThreadId) } : null,
    byModel: [...new Set(responses.map(r => r.model))]
      .map(model => ({ model, ...tokenWindow({ ...records,
        turns: records.turns.filter(t => t.model === model),
        cacheResponses: responses.filter(r => r.model === model),
      }, start, end) })),
    diagnostics: records.diagnostics,
    limitations: [
      'Counts are observed local response usage, not an account-wide bill or a full-week total. Missing usage is unavailable, not zero.',
      'Cached input is already in input; reasoning is already in output. Missing reasoning counters do not mean zero reasoning.',
      'Hourly consumption is workload burn, not streaming output tokens/s. Active hours union concurrent tasks and include tool waits.',
      'Quota windows carry tokens for their actual sample intervals, including extensions and current-cycle clipping.',
      'Tokens per quota percentage point is an observed mixed-workload ratio, not a fixed token budget; rounding, other devices and gaps affect it.',
    ],
  };
}
