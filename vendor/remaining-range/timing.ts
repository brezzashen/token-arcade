/** Defines speed-query metadata and interval/statistical operations. Union-based components exclude overlapping time; speed.test.ts verifies the partition. */
import { speedIdentity, totalUsage } from './speed-cost.ts';

export type Interval = [number, number];
export type IndexedThread = { id: string; rollout_path: string; cwd: string };
export type Diagnostics = Record<string, number>;
export type TokenUsage = { input: number; cachedInput: number; output: number };
export type Task = {
  id: string; thread: string; cwd: string; start: number; userAt?: number; end?: number;
  status: 'open' | 'complete' | 'interrupted'; models: Set<string>; efforts: Set<string>;
  reasoning: Map<string, Interval | null>; execution: Interval[];
  calls: Map<string, number>; returnedCalls: Set<string>; waits: Interval[];
  responses: Set<string>; reasoningTokens: number; tokenRecords: number;
  requestedTiers: Set<string>; servedTiers: Set<string>; servedTierRecords: number;
  usage: Map<string, TokenUsage | null>;
  usageAt: Map<string, number>;
  changedPaths: Set<string>; frontend: boolean; repair: boolean; deploy: boolean;
  excludedRequest: boolean; pending: boolean; deploymentTier: string;
  anchors: Record<string, string>;
};
export type Measurement = {
  id: string; thread: string; cwd: string; start: number; end: number; localDate: string;
  model: string; effort: string; totalMs: number; reasonMs: number; waitingMs: number;
  speedMode: string; speedBasis: string; serviceTiers: string[]; tokenUsage: TokenUsage | null;
  otherMs: number; rawToolWaitingMs: number; reasoningWaitingOverlapMs: number;
  executionWithBackgroundMs: number; reasoningBackgroundOverlapMs: number;
  steps: number; toolCalls: number; reasoningTokens: number | null;
  frontend: boolean; repair: boolean; deploy: boolean; deploymentTier: string;
  anchors: Record<string, string>;
};

export function merge(ranges: Interval[]): Interval[] {
  const sorted = ranges.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .map(([s, e]): Interval => [s, e]).sort((a, b) => a[0] - b[0]);
  const result: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = result.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else result.push([s, e]);
  }
  return result;
}

export const duration = (ranges: Interval[]) => merge(ranges).reduce((sum, [s, e]) => sum + e - s, 0);

export function overlap(a: Interval[], b: Interval[]): number {
  const left = merge(a), right = merge(b);
  let i = 0, j = 0, total = 0;
  while (i < left.length && j < right.length) {
    total += Math.max(0, Math.min(left[i][1], right[j][1]) - Math.max(left[i][0], right[j][0]));
    if (left[i][1] < right[j][1]) i++; else j++;
  }
  return total;
}

export function measure(task: Task, timezone: string): Measurement {
  const start = task.userAt ?? task.start, end = task.end!;
  const clip = (ranges: Interval[]) => ranges.map(([s, e]): Interval => [Math.max(s, start), Math.min(e, end)]);
  const reason = clip([...task.reasoning.values()].filter((v): v is Interval => v !== null));
  const waits = clip(task.waits), execution = clip([...task.execution, ...task.waits]);
  const shared = overlap(reason, waits);
  return {
    id: task.id, thread: task.thread, cwd: task.cwd, start, end,
    localDate: new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start),
    model: [...task.models][0], effort: [...task.efforts][0], totalMs: end - start,
    ...speedIdentity(task), tokenUsage: totalUsage(task),
    reasonMs: duration(reason), waitingMs: duration(waits) - shared,
    otherMs: end - start - duration([...reason, ...waits]), rawToolWaitingMs: duration(waits),
    reasoningWaitingOverlapMs: shared, executionWithBackgroundMs: duration(execution),
    reasoningBackgroundOverlapMs: overlap(reason, execution), steps: task.reasoning.size,
    toolCalls: task.calls.size, reasoningTokens: task.tokenRecords ? task.reasoningTokens : null,
    frontend: task.frontend, repair: task.repair, deploy: task.deploy,
    deploymentTier: task.deploymentTier, anchors: task.anchors,
  };
}

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * q;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function ranks(values: number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result: number[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j++;
    for (let k = i; k < j; k++) result[sorted[k].index] = (i + j - 1) / 2;
    i = j;
  }
  return result;
}

export function spearman(x: number[], y: number[]): number | null {
  if (x.length < 3 || x.length !== y.length) return null;
  const a = ranks(x), b = ranks(y), ma = mean(a)!, mb = mean(b)!;
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = a[i] - ma, dy = b[i] - mb;
    xy += dx * dy; xx += dx * dx; yy += dy * dy;
  }
  return xx && yy ? xy / Math.sqrt(xx * yy) : null;
}

export function statistics(tasks: Measurement[]) {
  const totalReason = tasks.reduce((sum, t) => sum + t.reasonMs, 0);
  const totalSteps = tasks.reduce((sum, t) => sum + t.steps, 0);
  const tokens = tasks.every(t => t.reasoningTokens !== null)
    ? tasks.reduce((sum, t) => sum + t.reasoningTokens!, 0) : null;
  return {
    n: tasks.length, meanTotalMs: mean(tasks.map(t => t.totalMs)), medianTotalMs: quantile(tasks.map(t => t.totalMs), .5),
    p90TotalMs: quantile(tasks.map(t => t.totalMs), .9), meanReasonMs: mean(tasks.map(t => t.reasonMs)),
    meanWaitingMs: mean(tasks.map(t => t.waitingMs)), meanOtherMs: mean(tasks.map(t => t.otherMs)),
    meanSteps: mean(tasks.map(t => t.steps)), pooledMeanStepMs: totalSteps ? totalReason / totalSteps : null,
    secondsPerThousandReasoningTokens: tokens ? totalReason / tokens : null,
    spearmanStepsVersusTotal: spearman(tasks.map(t => t.steps), tasks.map(t => t.totalMs)),
  };
}
