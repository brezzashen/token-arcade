/** Calibrates a token-weight heuristic to observed weekly quota deltas, including all locally recorded account turns and subagents. This is an allocation estimate, not OpenAI's subscription billing formula; speed.test.ts proves units, tier multipliers and response deduplication. */
import type { Diagnostics, Measurement, Task, TokenUsage } from './timing.ts';
import type { WeeklyQuota } from './weekly-quota.ts';
import { pricing, speedIdentity } from './speed-cost.ts';

export type QuotaCalibration = ReturnType<typeof calibrateQuota>;

function weight(model: string, speed: string, usage: TokenUsage): number | null {
  const rates = Object.hasOwn(pricing.standardRates, model) ? pricing.standardRates[model] : undefined;
  const multipliers: Record<string, number> = pricing.subscriptionUsageMultipliers;
  const multiplier = Object.hasOwn(multipliers, speed) ? multipliers[speed] : undefined;
  if (!rates || !multiplier || (speed === 'ultrafast' && model !== 'gpt-6-astra')) return null;
  return ((usage.input - usage.cachedInput) * rates.input + usage.cachedInput * rates.cachedInput
    + usage.output * rates.output) * multiplier / 1_000_000;
}

export function calibrateQuota(quota: WeeklyQuota, tasks: Task[], diagnostics: Diagnostics) {
  const windows = quota.windows.map(w => {
    const first = w.points[0], last = w.points.at(-1)!, responses = new Set<string>();
    let totalWeight = 0, recordedResponses = 0, assumedSpeedResponses = 0, missingUsageResponses = 0, unsupportedResponses = 0;
    for (const task of tasks) {
      const model = task.models.size === 1 ? [...task.models][0] : 'unknown';
      const speed = speedIdentity(task).speedMode;
      for (const [id, usage] of task.usage) {
        const at = task.usageAt.get(id);
        if (at === undefined || at <= first.at || at > last.at || responses.has(id)) continue;
        responses.add(id);
        if (!usage) { missingUsageResponses++; continue; }
        const assumed = speed === 'unknown' || speed === 'mixed';
        const weighted = weight(model, assumed ? 'standard' : speed, usage);
        if (weighted === null) { unsupportedResponses++; continue; }
        totalWeight += weighted; recordedResponses++;
        if (assumed) assumedSpeedResponses++;
      }
    }
    const delta = last.used - first.used;
    const reason = w.reason ?? (w.points.length < 2 ? 'insufficient_weekly_snapshots'
      : delta <= 0 ? 'insufficient_quota_delta' : totalWeight <= 0 ? 'missing_calibration_token_weights' : null);
    return { window: w.key, resetsAt: new Date(w.reset).toISOString(), status: reason ? 'unavailable' : 'estimated', reason,
      sampleStart: new Date(first.at).toISOString(), sampleEnd: new Date(last.at).toISOString(),
      samplePercentagePoints: reason ? null : delta, totalTokenWeight: totalWeight,
      percentagePointsPerWeight: reason ? null : delta / totalWeight,
      recordedResponses, assumedSpeedResponses, missingUsageResponses, unsupportedResponses,
      startEvidence: first.source ?? null, endEvidence: last.source ?? null };
  });
  return { method: 'Observed weekly quota delta / account token weights, then multiplied by each task token weight.',
    assumption: 'Quota burn is proportional to model input/cached-input/output rate weights and included-subscription speed multipliers. This is a heuristic, not the provider quota formula. Unknown/mixed speeds use Standard reference weight only in the calibration denominator; table rows retain their true unknown/mixed label.',
    limitations: 'Includes locally observed non-engineering turns, other projects and subagents. Missing files/responses, unsupported models, other devices, timing boundaries, quota rounding and non-token charges can bias estimates. The current calibration can be extrapolated to earlier task samples; it is not their measured historical consumption.',
    pricingSource: pricing.source, pricingVerifiedAt: pricing.verifiedAt, diagnostics, windows };
}

export function estimatedQuotaStatistics(tasks: Measurement[], calibration?: QuotaCalibration) {
  return { method: 'calibrated_token_weight',
    windows: (calibration?.windows ?? []).map(w => {
      const values = tasks.map(t => t.tokenUsage ? weight(t.model, t.speedMode, t.tokenUsage) : null);
      const known = values.filter((v): v is number => v !== null), full = tasks.length > 0 && known.length === tasks.length;
      const factor = w.percentagePointsPerWeight;
      const total = full && factor !== null ? known.reduce((sum, v) => sum + v, 0) * factor : null;
      const mean = total === null ? null : total / tasks.length;
      const display = (value: number | null) => value === null ? 'Unavailable'
        : value > 0 && value < 0.005 ? '<0.01%' : `${value.toFixed(2)}%`;
      return { window: w.window, resetsAt: w.resetsAt, status: mean === null ? 'unavailable' : 'estimated',
        meanEstimatedPercentagePoints: mean, totalEstimatedPercentagePoints: total,
        meanDisplay: display(mean), totalDisplay: display(total),
        estimatedTasks: factor === null ? 0 : known.length, totalTasks: tasks.length,
        reason: w.reason ?? (!full ? 'missing_token_usage_or_unknown_speed' : null) };
    }) };
}
