import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectReport } from './report.ts';
import { cacheable, carryForward, loadQuotaCache, mergeScopedWindows, saveQuotaCache } from './quota-cache.ts';
import { normalizeClaudeQuota } from './vendor/remaining-range/claude-quota.ts';

const now = Date.parse('2026-10-07T08:00:00Z');
const good = projectReport('co1', { capturedAt: '2026-10-07T07:40:00Z', planReportedByServer: 'pro', quota: { windows: [
  { window: 'codex:primary', windowMinutes: 10080, remainingPercent: 92, resetsAt: '2026-10-14T03:33:58Z' },
  { window: 'codex:secondary', windowMinutes: 300, remainingPercent: 40, resetsAt: '2026-10-07T07:50:00Z' }] } });
const failed = projectReport('co1', { capturedAt: '2026-10-07T08:00:00Z', error: 'Quota read failed' });

test('a failed read reuses the cached windows that have not reset', () => {
  const carried = carryForward(failed, good, now);
  assert.equal(carried.issue, null);
  assert.equal(carried.quotaSource, 'cached');
  assert.equal(carried.quotaObservedAt, '2026-10-07T07:40:00Z');
  assert.deepEqual(carried.windows.map(w => w.remainingPercent), [92]);
  assert.equal(carried.plan, 'pro');
  assert.equal(cacheable(carried), false);
});

test('a failed read without a cache or after every reset keeps the failure', () => {
  assert.equal(carryForward(failed, undefined, now).issue, '额度读取失败');
  assert.equal(carryForward(failed, good, Date.parse('2026-10-15T00:00:00Z')).issue, '额度读取失败');
});

test('a fresh reading always wins', () => {
  assert.equal(carryForward(good, good, now), good);
  assert.equal(cacheable(good), true);
});

test('the cache survives a restart', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'quota-cache-')), 'state/last-quota.json');
  await saveQuotaCache(path, new Map([['co1', good]]));
  assert.deepEqual((await loadQuotaCache(path)).get('co1'), good);
  assert.equal((await loadQuotaCache(`${path}.missing`)).size, 0);
});

test('statusline reads preserve live server-scoped Fable windows and unused 5-hour windows stay live inside a weekly cycle', () => {
  const normalized = normalizeClaudeQuota({
    limits: [
      { kind: 'session', percent: 0, resets_at: null },
      { kind: 'weekly_all', percent: 53, resets_at: '2026-10-14T05:00:00Z' },
      { kind: 'weekly_scoped', percent: 100, resets_at: null, scope: { model: { id: null, display_name: 'Fable' } } },
    ],
    weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 50, allowance_percent_of_weekly: 50 }],
  }, Date.parse('2026-10-07T07:56:00Z'));
  const serverRead = projectReport('cc3', { capturedAt: '2026-10-07T07:56:00Z', quota: { ...normalized, observedAt: '2026-10-07T07:56:00Z' } });
  const statuslineRead = projectReport('cc3', { capturedAt: '2026-10-07T07:59:00Z', quota: {
    source: 'claude-code-statusline', observedAt: '2026-10-07T07:59:00Z',
    windows: [
      { window: 'claude:five_hour', windowMinutes: 300, usedPercent: 79, remainingPercent: 21, resetsAt: '2026-10-07T11:30:00Z' },
      { window: 'claude:seven_day', windowMinutes: 10080, usedPercent: 54, remainingPercent: 46, resetsAt: '2026-10-14T05:00:00Z' },
    ],
  } });
  const merged = mergeScopedWindows(statuslineRead, serverRead, now);
  assert.equal(merged.windows.length, 3);
  const fable = merged.windows.find(w => w.scoped)!;
  assert.equal(fable.model, 'Fable');
  assert.equal(fable.remainingPercent, 0);
  assert.equal(fable.resetsAt, '2026-10-14T05:00:00.000Z');
  assert.deepEqual(fable.weeklyShare, { usedPercent: 50, allowancePercent: 50 });
  assert.equal(fable.observedAt, '2026-10-07T07:56:00Z');
  assert.equal(mergeScopedWindows(statuslineRead, serverRead, Date.parse('2026-10-15T00:00:00Z')).windows.length, 2);
  // Unused 5-hour window (resetsAt null, 100% remaining) stays live when carried forward inside the weekly cycle.
  const failedClaude = projectReport('cc3', { capturedAt: '2026-10-07T08:00:00Z', error: 'Claude usage HTTP 429.' });
  const carried = carryForward(failedClaude, serverRead, now);
  assert.deepEqual(carried.windows.map(w => [w.minutes, w.scoped, w.remainingPercent]), [[300, false, 100], [10080, false, 47], [10080, true, 0]]);
});
