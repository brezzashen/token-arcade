import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectReport } from './report.ts';
import { cacheable, carryForward, loadQuotaCache, saveQuotaCache } from './quota-cache.ts';

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
