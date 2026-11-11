/**
 * Carries the last successful quota reading forward when a collection fails, so one failed read
 * does not blank an account. Each cached window lives only until its own reset time, because the
 * next cycle's percentage cannot be inferred. The cache stores the sanitized projection only.
 * Proved by quota-cache.test.ts.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AccountReport, Alias } from './report.ts';

const futureReset = (window: AccountReport['windows'][number], now: number) => {
  const reset = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(reset) && reset > now;
};

const live = (window: AccountReport['windows'][number], now: number, hasLiveSibling = false) =>
  futureReset(window, now) || (hasLiveSibling && window.resetsAt === null && window.usedPercent === 0 && window.remainingPercent === 100);

/** Statusline readings omit server-scoped model windows (Fable); carry live scoped windows from the last server read. */
export function mergeScopedWindows(fresh: AccountReport, cached: AccountReport | undefined, now = Date.now()): AccountReport {
  if (!fresh.windows.length || !cached || fresh.windows.some(window => window.scoped)) return fresh;
  const siblingLive = cached.windows.some(window => futureReset(window, now));
  const carried = cached.windows.filter(window => window.scoped && live(window, now, siblingLive));
  return carried.length ? { ...fresh, windows: [...fresh.windows, ...carried] } : fresh;
}

/** A fresh reading with windows wins; otherwise the cached windows that have not reset yet. */
export function carryForward(fresh: AccountReport, cached: AccountReport | undefined, now = Date.now()): AccountReport {
  if (fresh.windows.length || !fresh.issue || !cached) return fresh;
  const siblingLive = cached.windows.some(window => futureReset(window, now));
  const windows = cached.windows.filter(window => live(window, now, siblingLive));
  if (!windows.length) return fresh;
  const telemetry = fresh.samples.length ? {} : { samples: cached.samples, models: cached.models, cache: cached.cache,
    forecast: cached.forecast, forecasts: cached.forecasts, telemetryIssue: cached.telemetryIssue };
  return { ...fresh, ...telemetry, windows, issue: null, label: cached.label, fingerprint: cached.fingerprint,
    plan: fresh.plan ?? cached.plan, quotaSource: 'cached',
    quotaObservedAt: cached.quotaObservedAt ?? cached.capturedAt };
}

/** Only readings that came straight from a provider seed the cache; a carried reading never re-seeds it. */
export const cacheable = (report: AccountReport) => report.windows.length > 0 && report.quotaSource !== 'cached';

export async function loadQuotaCache(path: string): Promise<Map<Alias, AccountReport>> {
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    return new Map(Array.isArray(stored) ? stored.filter(row => row?.alias && Array.isArray(row.windows))
      .map(row => [row.alias, row] as [Alias, AccountReport]) : []);
  } catch { return new Map(); }
}

export async function saveQuotaCache(path: string, cache: Map<Alias, AccountReport>) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify([...cache.values()]));
  await rename(`${path}.tmp`, path);
}
