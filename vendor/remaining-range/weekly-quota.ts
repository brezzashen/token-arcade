/** Supplies weekly snapshot deltas and strict isolated-turn observations alongside separately labelled calibrated token-weight estimates. Weekly cycles remain separate; speed.test.ts covers resets, overlap, resolution, missing records and estimates. */
import type { Measurement } from './timing.ts';
import type { Point, Records } from './records.ts';
import type { QuotaCalibration } from './quota-estimate.ts';
import { estimatedQuotaStatistics } from './quota-estimate.ts';

type WeeklyWindow = {
  key: string; reset: number; points: Point[]; status: string; reason: string | null;
};
export type WeeklyQuota = { windows: WeeklyWindow[]; records: Records; since: number; until: number; calibration?: QuotaCalibration };

export function prepareWeeklyQuota(records: Records, since: number, until: number): WeeklyQuota {
  const points = records.points.filter(p => p.minutes === 7 * 24 * 60 && p.at >= since && p.at <= until && p.reset > p.at);
  const windows = [...new Set(points.map(p => p.key))].sort().map(key => {
    const candidates = points.filter(p => p.key === key).sort((a, b) => a.at - b.at);
    const reset = candidates.at(-1)!.reset;
    // Match the existing forecast's five-second reset timestamp tolerance.
    const cycle = candidates.filter(p => Math.abs(p.reset - reset) <= 5000);
    const monotonic: Point[] = [];
    for (const p of cycle) if (!monotonic.length || p.used >= monotonic.at(-1)!.used) monotonic.push(p);
    const regressed = cycle.at(-1)!.used < monotonic.at(-1)!.used;
    return { key, reset, points: monotonic, status: regressed ? 'unavailable' : 'observed',
      reason: regressed ? 'terminal_quota_regression' : null };
  });
  return { windows, records, since, until };
}

export function weeklyQuotaSummary(quota?: WeeklyQuota) {
  return {
    status: quota?.windows.some(w => w.status === 'observed' && w.points.length >= 2) ? 'observed' : 'unavailable',
    scope: 'Historical account snapshots, latest visible weekly cycle per quota window; not project/engineering-only usage or a live quota read. Cycles and quota windows are never added.',
    unit: 'Percentage points of the full weekly quota; 1 percentage point is displayed as 1%. Not a percentage of remaining quota or task share.',
    attribution: 'Within-turn snapshot observations only, not complete billed task cost. Requires complete local records and no overlapping recorded turns. Other devices and delayed/rounded snapshots remain limitations.',
    diagnostics: quota?.records.diagnostics ?? {},
    calibration: quota?.calibration ?? null,
    windows: (quota?.windows ?? []).map(w => {
      const first = w.points[0], last = w.points.at(-1)!;
      return { window: w.key, windowMinutes: 10080, resetsAt: new Date(w.reset).toISOString(),
        status: w.points.length < 2 ? 'unavailable' : w.status,
        reason: w.points.length < 2 ? 'insufficient_weekly_snapshots' : w.reason,
        sampleStart: new Date(first.at).toISOString(), sampleEnd: new Date(last.at).toISOString(),
        startUsedPercent: first.used, endUsedPercent: last.used,
        samplePercentagePoints: w.status === 'observed' && w.points.length >= 2 ? last.used - first.used : null,
        startEvidence: first.source ?? null, endEvidence: last.source ?? null };
    }),
  };
}

function observeTurn(task: Measurement, window: WeeklyWindow, quota: WeeklyQuota) {
  const unavailable = (reason: string) => ({ percentagePoints: null, reason, sampleStart: null, sampleEnd: null,
    startEvidence: null, endEvidence: null });
  if (window.reason) return unavailable(window.reason);
  if (quota.records.diagnostics.unreadableFiles || quota.records.diagnostics.malformedLines) {
    return unavailable('incomplete_account_records');
  }
  if (task.start < window.reset - 7 * 24 * 3600_000 || task.end > window.reset) {
    return unavailable('outside_current_weekly_cycle');
  }
  if (!quota.records.turns.some(t => t.id === task.id && t.start <= task.start && t.end >= task.end)) {
    return unavailable('missing_account_turn_interval');
  }
  if (quota.records.turns.some(t => t.id !== task.id && t.start < task.end && t.end > task.start)) {
    return unavailable('overlapping_account_turns');
  }
  const points = window.points.filter(p => p.at >= task.start && p.at <= task.end);
  if (points.length < 2 || points.at(-1)!.at <= points[0].at) return unavailable('insufficient_within_turn_snapshots');
  const first = points[0], last = points.at(-1)!, delta = last.used - first.used;
  if (delta === 0) return unavailable('below_snapshot_resolution');
  return { percentagePoints: delta, reason: null,
    sampleStart: new Date(first.at).toISOString(), sampleEnd: new Date(last.at).toISOString(),
    startEvidence: first.source ?? null, endEvidence: last.source ?? null };
}

export function weeklyQuotaStatistics(tasks: Measurement[], quota?: WeeklyQuota) {
  return { status: quota?.windows.length ? 'sampled' : 'unavailable',
    reason: quota?.windows.length ? null : 'no_weekly_snapshots',
    estimate: estimatedQuotaStatistics(tasks, quota?.calibration),
    windows: (quota?.windows ?? []).map(w => {
      const observations = tasks.map(t => ({ id: t.id, ...observeTurn(t, w, quota!) }));
      const covered = observations.filter(o => o.percentagePoints !== null);
      const total = covered.reduce((sum, o) => sum + o.percentagePoints!, 0), reasons: Record<string, number> = {};
      for (const o of observations) if (o.reason) reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;
      const full = tasks.length > 0 && covered.length === tasks.length;
      return { window: w.key, resetsAt: new Date(w.reset).toISOString(),
        status: full ? 'observed' : 'unavailable', totalTasks: tasks.length, observedTasks: covered.length,
        meanPercentagePoints: full ? total / tasks.length : null,
        observedTotalPercentagePoints: covered.length ? total : null, unavailableReasons: reasons,
        observations: covered };
    }) };
}
