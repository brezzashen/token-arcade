/** Converts account quota deltas and all owned models' union activity into dashboard durations; exposes sample diagnostics without mixing reset cycles or counting concurrent time twice. */
import type { Turn, Records, Point } from './records.ts';
import type { LiveQuota, Window } from './quota.ts';

export function unionHours(turns: Turn[], start = -Infinity, end = Infinity): number {
  const spans = turns.map(t => [Math.max(t.start, start), Math.min(t.end, end)])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0, left = 0, right = -Infinity;
  for (const [a, b] of spans) {
    if (a > right) { if (right > left) total += right - left; left = a; right = b; }
    else right = Math.max(right, b);
  }
  if (right > left) total += right - left;
  return total / 3600_000;
}

const isAstra = (t: Turn) => t.model === 'gpt-6-astra';
const round = (n: number) => Math.round(n * 100) / 100;

function activity(turns: Turn[], start = -Infinity, end = Infinity) {
  const clipped = turns.map(t => ({ ...t, start: Math.max(start, t.start), end: Math.min(end, t.end) }))
    .filter(t => t.end > t.start);
  const byModel = [...new Set(clipped.map(t => t.model))].map(model => ({ model,
    activeHours: round(unionHours(clipped.filter(t => t.model === model))) }));
  const byRecordedTier = [...new Set(clipped.map(t => t.tier))].map(tier => ({ tier,
    activeHours: round(unionHours(clipped.filter(t => t.tier === tier))) }));
  return { activeHours: round(unionHours(clipped)),
    agentHours: round(clipped.reduce((sum, t) => sum + (t.end - t.start) / 3600_000, 0)),
    turns: clipped.length, incompleteTurns: clipped.filter(t => !t.complete).length,
    byModel, byRecordedTier };
}

export function dashboardDuration(hours: number | null) {
  if (hours === null) return { status: 'calibrating', remainingMinutes: null,
    hours: null, minutes: null, text: '预计剩余开发时间：校准中（暂无可靠估计）' };
  const remainingMinutes = Math.max(0, Math.round(hours * 60));
  const wholeHours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return { status: hours === 0 ? 'exhausted' : 'estimated', remainingMinutes,
    hours: wholeHours, minutes,
    text: hours === 0 ? '预计剩余开发时间：0 小时 0 分钟'
      : `预计剩余开发时间：约 ${wholeHours} 小时 ${minutes} 分钟` };
}

function measure(points: Point[], turns: Turn[]) {
  if (points.length < 2) return null;
  const first = points[0], last = points.at(-1)!;
  if (last.at <= first.at) return null;
  const hours = unionHours(turns, first.at, last.at);
  const delta = last.used - first.used;
  return { hours, delta, start: first.at, end: last.at };
}

function calibrationIssue(sample: ReturnType<typeof measure>) {
  if (!sample) return { reasonCode: 'insufficient_quota_snapshots',
    reason: 'Need two quota snapshots at distinct times in the current reset cycle.' };
  if (sample.hours === 0) return { reasonCode: 'no_active_time',
    reason: 'No owned model activity was recorded between the quota snapshots.' };
  if (sample.hours < 0.25) return { reasonCode: 'insufficient_active_time',
    reason: 'Need at least 15 active minutes between quota snapshots in the current reset cycle.' };
  if (sample.delta <= 2) return { reasonCode: 'insufficient_quota_delta',
    reason: 'Need more than 2 percentage points of quota consumption in the sample.' };
  return null;
}

export function windowForecast(window: Window, live: LiveQuota, records: Records, lookbackHours: number | null = 1) {
  const remaining = 100 - window.used;
  const base = { window: window.key, windowMinutes: window.minutes, remainingPercent: remaining,
    resetsAt: new Date(window.reset).toISOString() };
  if (window.reset <= live.at) return { ...base, status: 'calibrating', reasonCode: 'expired_reset',
    reason: 'Snapshot reset time is already past.' };
  if (remaining === 0) return { ...base, status: 'exhausted', activeHours: 0, rangeHours: [0, 0] };
  const points = records.points.filter(p => p.key === window.key && p.minutes === window.minutes
    && Math.abs(p.reset - window.reset) <= 5000 && p.at <= live.at).sort((a, b) => a.at - b.at);
  const monotonic: Point[] = [];
  for (const p of points) {
    if (!monotonic.length || p.used >= monotonic.at(-1)!.used) monotonic.push(p);
  }
  if (monotonic.length && monotonic.at(-1)!.used > window.used) {
    return { ...base, status: 'calibrating', reasonCode: 'regressed_live_usage',
      reason: 'Live usage regressed relative to recorded usage; possible reset or delayed data.' };
  }
  monotonic.push({ ...window, at: live.at });
  const cutoff = lookbackHours === null ? -Infinity : live.at - lookbackHours * 3600_000;
  let selected = monotonic.filter(p => p.at >= cutoff);
  let full = measure(selected, records.turns);
  let sampleBasis = lookbackHours === null ? 'today_current_cycle_sample' : 'requested_lookback';
  if (calibrationIssue(full)) {
    for (let index = monotonic.length - 2; index >= 0; index--) {
      if (monotonic[index].at >= cutoff) continue;
      const candidate = measure([monotonic[index], monotonic.at(-1)!], records.turns);
      if (!calibrationIssue(candidate)) {
        selected = monotonic.slice(index); full = candidate;
        sampleBasis = 'extended_current_cycle_sample'; break;
      }
    }
  }
  const issue = calibrationIssue(full);
  if (!full) return { ...base, status: 'calibrating', ...issue! };
  const workload = activity(records.turns, full.start, full.end);
  const sample = { sampleActiveHours: workload.activeHours, sampleAgentHours: workload.agentHours,
    samplePercentagePoints: full.delta, sampleByModel: workload.byModel,
    sampleByRecordedTier: workload.byRecordedTier,
    workload: workload.byModel.length === 1 && workload.byModel[0].model !== 'unknown'
      ? `${workload.byModel[0].model} workload` : 'current mixed workload',
    sampleBasis, sampleWallClockMinutes: round((full.end - full.start) / 60_000),
    sampleStart: new Date(full.start).toISOString(), sampleEnd: new Date(full.end).toISOString(),
    sampleStartEvidence: selected[0].source ?? null,
    sampleEndEvidence: 'Live account/rateLimits/read at capturedAt' };
  if (issue) return { ...base, ...sample, status: 'calibrating', ...issue };
  const recentStart = lookbackHours === null
    ? (full.start + full.end) / 2 : live.at - lookbackHours * 1800_000;
  const recent = measure(monotonic.filter(p => p.at >= recentStart), records.turns);
  const samples = [full, ...(recent && !calibrationIssue(recent) ? [recent] : [])];
  const lowRate = Math.min(...samples.map(s => (s.delta - 1) / s.hours));
  const highRate = Math.max(...samples.map(s => (s.delta + 1) / s.hours));
  const other = records.turns.filter(t => !isAstra(t));
  const rate = full.delta / full.hours;
  return { ...base, ...sample, status: 'estimated', activeHours: round(remaining / rate),
    rangeHours: [round(remaining / highRate), round(remaining / lowRate)],
    percentagePointsPerActiveHour: round(rate),
    otherModelActiveHours: round(unionHours(other, full.start, full.end)),
    scope: 'Account quota consumption per union active hour across all owned models at the observed workload and concurrency',
    rangeKind: 'Heuristic sensitivity band, not a confidence interval' };
}

function estimate(live: LiveQuota, records: Records, lookbackHours: number | null) {
  const windows = live.windows.map(w => windowForecast(w, live, records, lookbackHours));
  const known = windows.filter(w => 'activeHours' in w);
  const total = windows.some(w => w.status === 'exhausted') ? 0
    : windows.length > 0 && known.length === windows.length
      ? Math.min(...known.map(w => w.activeHours!)) : null;
  return { dashboard: dashboardDuration(total), remainingActiveHours: total,
    tenHourActiveUseEquivalents: total === null ? null : round(total / 10), windows };
}

export function buildReport(live: LiveQuota, records: Records, start: number, timezone: string, lookbackHours = 1) {
  const astra = records.turns.filter(isAstra);
  const today = activity(records.turns);
  const byTier = [...new Set(astra.map(t => t.tier))].map(tier => ({ tier,
    activeHours: round(unionHours(astra.filter(t => t.tier === tier))) }));
  const samples = [
    { id: 'last_hour', label: '最近 1 小时', lookbackHours: 1 },
    { id: 'last_three_hours', label: '最近 3 小时', lookbackHours: 3 },
    { id: 'last_five_hours', label: '最近 5 小时', lookbackHours: 5 },
    { id: 'today', label: '今天全天', lookbackHours: null },
  ].map(sample => ({ ...sample,
    requestedStart: new Date(sample.lookbackHours === null ? start
      : Math.max(start, live.at - sample.lookbackHours * 3600_000)).toISOString(),
    ...estimate(live, records, sample.lookbackHours) }));
  const primary = samples.find(sample => sample.lookbackHours === lookbackHours)
    ?? estimate(live, records, lookbackHours);
  return { title: 'Remaining Range', capturedAt: new Date(live.at).toISOString(), timezone,
    dashboard: primary.dashboard, samples,
    accountFingerprint: live.fingerprint, planReportedByServer: live.plan, lookbackHours,
    baseline: { developmentDaysPerWeek: 6, workingHoursPerDay: 10 },
    today: { start: new Date(start).toISOString(), ...today, astraActiveHours: round(unionHours(astra)),
      astraAgentHours: round(astra.reduce((sum, t) => sum + (t.end - t.start) / 3600_000, 0)),
      astraTurns: astra.length, incompleteAstraTurns: astra.filter(t => !t.complete).length,
      astraByRecordedTier: byTier },
    remainingActiveHours: primary.remainingActiveHours,
    tenHourActiveUseEquivalents: primary.tenHourActiveUseEquivalents,
    windows: primary.windows, separateCredits: live.extras, availableResetCount: live.resetCount,
    diagnostics: records.diagnostics, evidence: records.anchors,
    limitations: [
      'Local task runtime includes tools; it excludes gaps between turns and merges parallel intervals.',
      'Open turns stop at the last observed event. Today may be incomplete.',
      'Forecast includes all recorded owned models and speed modes; other devices or missing records can still consume shared quota.',
      'Active-hour range is not calendar time or a promise to last until reset.',
    ] };
}
