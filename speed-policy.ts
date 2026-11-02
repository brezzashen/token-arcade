/** Separates model/mode cohorts and prioritizes their fresh tasks; content-speed.test.ts protects fallback deduplication. */
type Sample = { source: string; mode?: string; tokensPerSecond: number | null; sampledAt: string };
export function normalizeMode(mode: unknown) {
  const value = typeof mode === 'string' ? mode.toLowerCase() : '';
  return ['default', 'standard'].includes(value) ? 'standard' : ['priority', 'fast'].includes(value) ? 'fast'
    : ['ultrafast', 'vertex', 'subscription'].includes(value) ? value : 'unknown';
}
export const sampleKey = (sample: { model: string; mode?: string }) => `${sample.model}|${normalizeMode(sample.mode)}`;
export const freshTask = (sample: Sample | undefined, now: number) => !!sample && sample.source === 'task'
  && sample.tokensPerSecond !== null && Date.parse(sample.sampledAt) > now - 3600_000;
export function acceptSample(previous: Sample | undefined, sample: Sample, now: number) {
  if (!previous) return true;
  if (normalizeMode(previous.mode) !== normalizeMode(sample.mode)) return true;
  if (sample.source === 'fallback' && freshTask(previous, now)) return false;
  if (sample.source === 'task' && sample.tokensPerSecond === null && previous.tokensPerSecond !== null
    && Date.parse(previous.sampledAt) > now - 3600_000) return false;
  return !(sample.source === 'task' && previous.source === 'task'
    && Date.parse(sample.sampledAt) < Date.parse(previous.sampledAt));
}
