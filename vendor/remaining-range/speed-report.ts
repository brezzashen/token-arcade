/** Selects completed engineering turns from either agent's parser and summarizes model/effort, speed tiers, timing, request completion counts and sampled weekly-quota percentages. Credit and quota fields exist only for Codex; Claude rows report them unavailable. Emits no conversation text. */
import { isAbsolute, relative } from 'node:path';
import { measure, quantile, statistics } from './timing.ts';
import type { Diagnostics, Measurement, Task } from './timing.ts';
import { costStatistics, creditEstimate, pricing, speedIdentity } from './speed-cost.ts';
import { weeklyQuotaStatistics, weeklyQuotaSummary } from './weekly-quota.ts';
import type { WeeklyQuota } from './weekly-quota.ts';

export type TaskType = 'all' | 'frontend' | 'frontend-repair' | 'deployment';
export function repositoryChange(task: Task): boolean {
  return [...task.changedPaths].some(path => {
    const local = relative(task.cwd, path);
    return local !== '' && local !== '..' && !local.startsWith('../') && !isAbsolute(local)
      && !local.split('/').includes('.tmp');
  });
}

function exclusion(task: Task, project?: string): string | null {
  if (project && task.cwd !== project) return 'otherProject';
  if (task.excludedRequest || (!repositoryChange(task) && !task.deploy)) return 'nonEngineering';
  if (task.status !== 'complete') return 'unfinished';
  if (task.pending) return 'reportedPending';
  if (!task.end || task.end <= (task.userAt ?? task.start) || !task.anchors.final || !task.anchors.user) return 'missingFinalOrUser';
  if (task.models.size !== 1 || task.efforts.size !== 1 || task.models.has('unknown') || task.efforts.has('unknown')) return 'mixedOrUnknownModel';
  if (!task.reasoning.size || [...task.reasoning.values()].some(v => !v)) return 'missingReasoningTiming';
  if (task.calls.size !== task.returnedCalls.size) return 'unmatchedTools';
  if (!task.anchors.context || !task.anchors.complete) return 'missingSources';
  return null;
}

function selectType(task: Pick<Task, 'frontend' | 'repair' | 'deploy'>, type: TaskType): boolean {
  return type === 'all' || (type === 'frontend' && task.frontend)
    || (type === 'frontend-repair' && task.frontend && task.repair)
    || (type === 'deployment' && task.deploy);
}

function modelGroups(tasks: Measurement[]) {
  return [...new Set(tasks.map(t => `${t.model}/${t.effort}`))].sort().map(key => ({
    key, model: tasks.find(t => `${t.model}/${t.effort}` === key)!.model,
    effort: tasks.find(t => `${t.model}/${t.effort}` === key)!.effort,
    ...statistics(tasks.filter(t => `${t.model}/${t.effort}` === key)),
  }));
}

function speedGroups(tasks: Measurement[], weeklyQuota?: WeeklyQuota) {
  const key = (t: Measurement) => `${t.model}/${t.effort}/${t.speedMode}/${t.speedBasis}`;
  return [...new Set(tasks.map(key))].sort().map(k => {
    const sample = tasks.filter(t => key(t) === k), first = sample[0];
    return { key: k, model: first.model, effort: first.effort, speedMode: first.speedMode,
      speedBasis: first.speedBasis, ...statistics(sample), cost: costStatistics(sample),
      weeklyQuota: weeklyQuotaStatistics(sample, weeklyQuota) };
  });
}

function compareSpeeds(tasks: Measurement[], weeklyQuota?: WeeklyQuota) {
  const identity = (t: Measurement) => `${t.model}/${t.effort}/${t.speedBasis}`;
  return [...new Set(tasks.map(identity))].sort().map(key => {
    const sample = tasks.filter(t => identity(t) === key);
    const standard = sample.filter(t => t.speedMode === 'standard'), fast = sample.filter(t => t.speedMode === 'fast');
    const s = statistics(standard), f = statistics(fast), sc = costStatistics(standard), fc = costStatistics(fast);
    const costCovered = sc.estimatedTasks === standard.length && fc.estimatedTasks === fast.length;
    const sq = weeklyQuotaStatistics(standard, weeklyQuota), fq = weeklyQuotaStatistics(fast, weeklyQuota);
    return { key, status: standard.length && fast.length ? 'available' : 'insufficient_speed_samples',
      standardTasks: standard.length, fastTasks: fast.length,
      standardMeanTotalMs: s.meanTotalMs, fastMeanTotalMs: f.meanTotalMs,
      standardMeanEstimatedCredits: sc.meanEstimatedCredits, fastMeanEstimatedCredits: fc.meanEstimatedCredits,
      meanCompletionSpeedup: s.meanTotalMs && f.meanTotalMs ? s.meanTotalMs / f.meanTotalMs : null,
      medianCompletionSpeedup: s.medianTotalMs && f.medianTotalMs ? s.medianTotalMs / f.medianTotalMs : null,
      estimatedCreditRatio: costCovered && sc.meanEstimatedCredits && fc.meanEstimatedCredits !== null
        ? fc.meanEstimatedCredits / sc.meanEstimatedCredits : null,
      weeklyQuota: sq.windows.map(w => {
        const fastWindow = fq.windows.find(v => v.window === w.window && v.resetsAt === w.resetsAt);
        const standardEstimate = sq.estimate.windows.find(v => v.window === w.window && v.resetsAt === w.resetsAt);
        const fastEstimate = fq.estimate.windows.find(v => v.window === w.window && v.resetsAt === w.resetsAt);
        const se = standardEstimate?.meanEstimatedPercentagePoints ?? null, fe = fastEstimate?.meanEstimatedPercentagePoints ?? null;
        return { window: w.window, resetsAt: w.resetsAt,
          standardMeanPercentagePoints: w.meanPercentagePoints,
          fastMeanPercentagePoints: fastWindow?.meanPercentagePoints ?? null,
          standardObservedTasks: w.observedTasks, fastObservedTasks: fastWindow?.observedTasks ?? 0,
          standardMeanEstimatedPercentagePoints: se, fastMeanEstimatedPercentagePoints: fe,
          estimatedQuotaConsumptionRatio: se && fe !== null ? fe / se : null,
          quotaConsumptionRatio: w.meanPercentagePoints && fastWindow?.meanPercentagePoints !== null
            && fastWindow?.meanPercentagePoints !== undefined ? fastWindow.meanPercentagePoints / w.meanPercentagePoints : null };
      }) };
  });
}

function completion(tasks: Task[], project: string | undefined, type: TaskType) {
  const requests = tasks.filter(t => (!project || t.cwd === project) && !t.excludedRequest);
  const engineering = requests.filter(t => (repositoryChange(t) || t.deploy) && selectType(t, type));
  const counts = (sample: Task[]) => ({ total: sample.length,
    complete: sample.filter(t => t.status === 'complete' && !t.pending).length,
    reportedPending: sample.filter(t => t.status === 'complete' && t.pending).length,
    interrupted: sample.filter(t => t.status === 'interrupted').length,
    open: sample.filter(t => t.status === 'open').length });
  const timed = engineering.filter(t => t.status === 'complete' && !t.pending && t.anchors.final
    && t.end !== undefined && t.end > (t.userAt ?? t.start));
  const label = (values: Set<string>) => values.size === 1 ? [...values][0] : values.size ? 'mixed' : 'unknown';
  const key = (t: Task) => `${label(t.models)}/${label(t.efforts)}/${speedIdentity(t).speedMode}`;
  const times = (sample: Task[]) => {
    const ms = sample.map(t => t.end! - (t.userAt ?? t.start));
    return { n: ms.length, meanTotalMs: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null,
      medianTotalMs: quantile(ms, .5), p90TotalMs: quantile(ms, .9) };
  };
  return { scope: 'User requests in the selected project and interval, excluding metadata, commit/push and system-initiated requests. Engineering = repository file changes or explicit deployment requests, narrowed by --type. complete excludes replies reporting pending work; open turns have no recorded end yet.',
    requests: counts(requests), engineering: counts(engineering),
    completionTime: { basis: 'Completed engineering requests from the user prompt to the final answer, including turns without reasoning timing; the speed tables use the stricter timed subset.',
      ...times(timed), groups: [...new Set(timed.map(key))].sort().map(k => {
        const sample = timed.filter(t => key(t) === k), [model, effort, speedMode] = k.split('/');
        return { key: k, model, effort, speedMode, ...times(sample) };
      }) } };
}

const claudeMethodology = {
  reasoning: 'Union of Claude Code thinkingDurationMs per thinking block (recorded from CLI 2.1.287), anchored to that block\'s record timestamp. Earlier transcripts lack it: those turns count in completion but not in timing averages.',
  waiting: 'Union of tool_use to tool_result intervals, with any thinking overlap assigned to reasoning.',
  speed: 'Recorded response usage.speed per API message; partial coverage stays unknown. No request-tier record exists.',
  cost: 'Unavailable: the Codex credit rate card does not apply to Claude models.',
  weeklyQuota: 'Unavailable: Claude Code transcripts carry no quota snapshots.',
  ownership: 'Transcripts carry no account id; ownership is the selected Claude config directory, fingerprinted from its current login. A re-login inside the interval cannot be detected.',
  scope: 'Interactive cli/claude-desktop root sessions only. Headless claude -p sessions, sidechains and subagents/ files are excluded. File changes are Edit/Write/MultiEdit/NotebookEdit paths; edits made through Bash are not detected.',
};

export function buildSpeedReport(tasks: Task[], diagnostics: Diagnostics, options: {
  since: number; until: number; timezone: string; project?: string; type: TaskType;
  fingerprint: string; index: string; details: boolean; weeklyQuota?: WeeklyQuota; agent?: 'codex' | 'claude';
}) {
  const agent = options.agent ?? 'codex';
  const exclusions: Diagnostics = {}, completed: Measurement[] = [];
  for (const task of tasks) {
    const reason = exclusion(task, options.project);
    if (reason) { exclusions[reason] = (exclusions[reason] ?? 0) + 1; continue; }
    const measured = measure(task, options.timezone);
    if (selectType(measured, options.type)) completed.push(measured);
    else exclusions.otherTaskType = (exclusions.otherTaskType ?? 0) + 1;
  }
  const modelKeys = modelGroups(completed);
  const daily = [...new Set(completed.map(t => t.localDate))].sort().flatMap(date =>
    modelGroups(completed.filter(t => t.localDate === date)).map(group => ({ date, ...group })));
  const stepBands = [{ name: '1-10', low: 1, high: 10 }, { name: '11-30', low: 11, high: 30 },
    { name: '31-60', low: 31, high: 60 }, { name: '61+', low: 61, high: Infinity }].map(band => {
    const sample = completed.filter(t => t.steps >= band.low && t.steps <= band.high);
    return { band: band.name, ...statistics(sample), models: modelGroups(sample) };
  });
  const types = [
    { name: 'frontend-repair', sample: completed.filter(t => t.frontend && t.repair) },
    { name: 'frontend-change', sample: completed.filter(t => t.frontend) },
    { name: 'standalone-deployment', sample: completed.filter(t => t.deploy) },
  ].map(({ name, sample }) => ({ name, models: modelGroups(sample), speedGroups: speedGroups(sample, options.weeklyQuota) }));
  const deploymentTargets = [...new Set(completed.filter(t => t.deploy).map(t => t.deploymentTier))].sort()
    .map(tier => {
      const sample = completed.filter(t => t.deploy && t.deploymentTier === tier);
      return { tier, models: modelGroups(sample), speedGroups: speedGroups(sample, options.weeklyQuota) };
    });
  const sensitivity = modelKeys.map(group => {
    const sample = completed.filter(t => `${t.model}/${t.effort}` === group.key), long = sample.filter(t => t.totalMs > 3_600_000);
    return { key: group.key, overOneHour: long.length,
      longTasksShareOfTotal: long.reduce((sum, t) => sum + t.totalMs, 0) / sample.reduce((sum, t) => sum + t.totalMs, 0),
      excludingOverOneHour: statistics(sample.filter(t => t.totalMs <= 3_600_000)) };
  }).filter(g => g.overOneHour);
  return {
    status: completed.length ? 'ok' : 'no_samples',
    methodology: { since: new Date(options.since).toISOString(), until: new Date(options.until).toISOString(),
      timezone: options.timezone, project: options.project ?? 'all', type: options.type,
      unit: 'One user request to its logged final answer; gaps between turns excluded. Completion is a logged ended engineering turn, not independent acceptance of a feature.',
      reasoning: 'Union of logged Reasoning item durations; segments are not internal semantic steps or pure token-compute latency.',
      waiting: 'Union of top-level tool-call waits, with any Reasoning overlap assigned to reasoning. Background execution is separate and not added to elapsed time.',
      other: 'Elapsed time outside reasoning and top-level waits, including response generation, orchestration and unclassified gaps.',
      grouping: 'Historical per-turn contexts and settings, never the latest thread model. modelGroups pools speed tiers for compatibility; speedGroups separates model/effort/speed/basis. Task-type groups overlap; do not sum them.',
      speed: 'priority/fast => Fast; default/standard => Standard; missing/auto/unsupported => unknown. Recorded response tiers override requests only with complete tier coverage; request tiers do not prove the served tier. Changes during a turn remain mixed.',
      cost: 'Recorded response tokens at the dated current Codex credit rate card. Cached input is discounted; output includes reasoning, which is never added twice. Incomplete usage or unknown/mixed speed yields unavailable. Not measured bills or subscription quota.',
      weeklyQuota: 'Primary table uses weeklyQuota.estimate meanDisplay: estimated percent of full weekly quota per turn, calibrated from observed quota delta and account token weights. This proportional allocation is a heuristic, not the provider quota formula. Unknown/mixed row speeds remain unavailable. Raw meanPercentagePoints retains strict isolated-turn observation checks. Account observed deltas are separate from project/engineering estimates; no fixed credit-to-percent conversion.',
      caveats: 'Task size, retries, context, network and deployment tier vary; cohort averages and step correlations are descriptive, not causal model rankings.',
      ownership: 'Current local auth identity matched to indexed thread creators and rollout metadata. Cross-account resumes cannot prove ownership of every request.',
      persistence: 'None. Read-only sources; results are printed only.',
      agent, ...(agent === 'claude' ? claudeMethodology : {}) },
    accountFingerprint: options.fingerprint, index: options.index, diagnostics, exclusions,
    completedCount: completed.length, completion: completion(tasks, options.project, options.type),
    overall: { ...statistics(completed), weeklyQuota: weeklyQuotaStatistics(completed, options.weeklyQuota) }, modelGroups: modelKeys,
    pricing: agent === 'codex' ? pricing : null, speedGroups: speedGroups(completed, options.weeklyQuota), speedComparisons: compareSpeeds(completed, options.weeklyQuota),
    weeklyQuota: weeklyQuotaSummary(options.weeklyQuota),
    daily, taskTypes: types, deploymentTargets, stepBands, sensitivity,
    verification: {
      componentsValid: completed.every(t => Math.abs(t.totalMs - t.reasonMs - t.waitingMs - t.otherMs) < 1 && t.otherMs >= 0),
      sourcesCovered: completed.every(t => ['start', 'context', 'user', 'reasoning', 'final', 'complete'].every(k => t.anchors[k])),
    },
    examples: completed.slice(-3).map(t => ({ id: t.id, model: t.model, effort: t.effort, anchors: t.anchors })),
    ...(options.details ? { tasks: completed.map(t => ({ ...t, cost: creditEstimate(t) })) } : {}),
  };
}
