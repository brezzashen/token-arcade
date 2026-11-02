/** Normalizes recorded speed tiers and estimates Codex credits from deduplicated token metadata. The dated official rate card is an estimate, never a bill or subscription quota attribution; speed.test.ts covers missing data and tier changes. */
import type { Measurement, Task, TokenUsage } from './timing.ts';

export const pricing = {
  source: 'https://learn.chatgpt.com/docs/pricing', verifiedAt: '2026-10-01',
  unit: 'Codex credits per million tokens',
  scope: 'Current rate-card estimate for recorded root-turn responses only; excludes subagents, missing responses and non-token charges. Not billed credits, USD or measured subscription quota.',
  standardRates: {
    'gpt-6-astra': { input: 250, cachedInput: 25, output: 1250 },
    'gpt-6.1-sol': { input: 50, cachedInput: 2.5, output: 250 },
    'gpt-6-sol': { input: 50, cachedInput: 5, output: 250 },
    'gpt-6-luna': { input: 2.5, cachedInput: 0.25, output: 12.5 },
    'gpt-5.6-sol': { input: 100, cachedInput: 10, output: 500 },
  } as Record<string, TokenUsage>,
  creditMultipliers: { standard: 1, fast: 2, ultrafast: 6 } as Record<string, number>,
  subscriptionUsageMultipliers: { standard: 1, fast: 2.5, ultrafast: 8 },
};

export function normalizeTier(tier: string): string {
  if (tier === 'default' || tier === 'standard') return 'standard';
  if (tier === 'priority' || tier === 'fast') return 'fast';
  return tier === 'ultrafast' ? 'ultrafast' : 'unknown';
}

export function requestedTier(task: Task, tier: unknown, anchor: string): void {
  if (typeof tier !== 'string') return;
  // Settings can arrive after turn_context but before the first model response.
  if (!task.usage.size && !task.reasoning.size) task.requestedTiers.clear();
  task.requestedTiers.add(tier); task.anchors.speed = anchor;
}

export function speedIdentity(task: Task) {
  const partial = task.servedTiers.size > 0 && task.servedTierRecords !== task.usage.size;
  const tiers = partial ? new Set(['unknown']) : task.servedTiers.size ? task.servedTiers : task.requestedTiers;
  const modes = new Set([...tiers].map(normalizeTier));
  return { speedMode: modes.size > 1 ? 'mixed' : [...modes][0] ?? 'unknown',
    speedBasis: partial ? 'partial_response' : task.servedTiers.size ? 'response'
      : tiers.size && !(tiers.size === 1 && tiers.has('unknown')) ? 'request' : 'unknown',
    serviceTiers: [...new Set([...task.requestedTiers, ...task.servedTiers])].sort() };
}

export function recordUsage(task: Task, payload: any, anchor: string, at: number): void {
  const id = payload.response_id;
  if (typeof id === 'string' && task.responses.has(id)) return;
  if (typeof id === 'string') task.responses.add(id);
  const u = payload.usage ?? {}, reason = u.reasoning_output_tokens;
  if (Number.isFinite(reason) && reason >= 0) { task.reasoningTokens += reason; task.tokenRecords++; }
  const input = u.input_tokens, cachedInput = u.cached_input_tokens, output = u.output_tokens;
  const valid = typeof id === 'string' && [input, cachedInput, output].every(v => Number.isSafeInteger(v) && v >= 0)
    && cachedInput <= input;
  task.usage.set(typeof id === 'string' ? id : anchor, valid ? { input, cachedInput, output } : null);
  task.usageAt.set(typeof id === 'string' ? id : anchor, at);
  if (typeof payload.service_tier === 'string') {
    task.servedTiers.add(payload.service_tier); task.servedTierRecords++; task.anchors.servedSpeed = anchor;
  }
  task.anchors.tokens ??= anchor;
}

export function totalUsage(task: Task): TokenUsage | null {
  if (!task.usage.size || [...task.usage.values()].some(u => u === null)) return null;
  return [...task.usage.values()].reduce<TokenUsage>((sum, u) => ({
    input: sum.input + u!.input, cachedInput: sum.cachedInput + u!.cachedInput, output: sum.output + u!.output,
  }), { input: 0, cachedInput: 0, output: 0 });
}

export function creditEstimate(task: Measurement): { credits: number | null; reason: string | null } {
  const rates = Object.hasOwn(pricing.standardRates, task.model) ? pricing.standardRates[task.model] : undefined;
  const multiplier = Object.hasOwn(pricing.creditMultipliers, task.speedMode) ? pricing.creditMultipliers[task.speedMode] : undefined;
  if (!rates) return { credits: null, reason: 'unsupported_model_rate' };
  if (!multiplier) return { credits: null, reason: 'unknown_or_mixed_speed' };
  if (task.speedMode === 'ultrafast' && task.model !== 'gpt-6-astra') return { credits: null, reason: 'unsupported_ultrafast_rate' };
  if (!task.tokenUsage) return { credits: null, reason: 'missing_or_invalid_token_usage' };
  const u = task.tokenUsage;
  return { credits: ((u.input - u.cachedInput) * rates.input + u.cachedInput * rates.cachedInput + u.output * rates.output)
    * multiplier / 1_000_000, reason: null };
}

export function costStatistics(tasks: Measurement[]) {
  const estimates = tasks.map(creditEstimate), known = estimates.filter(e => e.credits !== null);
  const sum = known.reduce((total, e) => total + e.credits!, 0), reasons: Record<string, number> = {};
  for (const e of estimates) if (e.reason) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
  return { estimatedTasks: known.length, unavailableTasks: tasks.length - known.length,
    meanEstimatedCredits: known.length ? sum / known.length : null,
    totalEstimatedCredits: known.length ? sum : null, unavailableReasons: reasons };
}
