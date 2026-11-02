/** Verify the native quota contract and timestamp-based response speed, including malformed and incomplete data. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ANTIGRAVITY_QUOTA_TTL_MS, parseAntigravityQuota, readAntigravityQuota } from './antigravity-quota.ts';
import { antigravityResponse, decodeWire, readAntigravitySpeed } from './antigravity-speed.ts';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DialogSpeed } from './dialog-speed.ts';
import { projectReport } from './report.ts';
import { overview } from './web/overview.ts';
import { outputSpeed } from './web/output-speed.ts';
import { speedHistory } from './web/speed-history.ts';

const now = Date.now();
const quota = (fraction: any = .77, reset = new Date(now + 3600_000).toISOString()) => ({
  status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: fraction, reset_time: reset }] },
    { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: reset }] },
  ] } } });
test('native quotas preserve percentages, zero, reset time and separate model groups', () => {
  const parsed = parseAntigravityQuota(quota(), now);
  assert.equal(parsed.windows[0].remainingPercent, 77);
  assert.ok(Math.abs(parsed.windows[0].usedPercent - 23) < 1e-8);
  assert.equal(parsed.windows[0].windowMinutes, 300);
  assert.equal(parsed.windows[0].modelScope, null);
  assert.equal(parsed.windows[1].modelScope.label, 'Claude and GPT models');
  assert.equal(parseAntigravityQuota(quota(0), now).windows[0].remainingPercent, 0);
  const html = overview([projectReport('gm', { quota: parsed })]);
  assert.match(html, /77%/);
  assert.doesNotMatch(html, /暂未提供读数<\/span><\/td><td>/);
});
test('bad, expired and non-command quota responses never become valid percentages', () => {
  for (const fraction of [-1, 2, '77', null, Infinity]) assert.equal(parseAntigravityQuota(quota(fraction), now).windows.length, 1);
  assert.throws(() => parseAntigravityQuota(quota(.77, new Date(now - 1000).toISOString()), now));
  assert.throws(() => parseAntigravityQuota({ ...quota(), num_turns: 1 }, now));
  assert.throws(() => parseAntigravityQuota({ status: 'ERROR' }, now));
});

const varint = (value: number) => {
  const bytes: number[] = [];
  do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part + (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
};
const int = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);
const message = (field: number, value: Buffer) => Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
const time = (field: number, value: number, extraNanos = 0) => message(field, Buffer.concat([int(1, Math.floor(value / 1000)), int(2, value % 1000 * 1e6 + extraNanos)]));
const metadata = (start: number, finish: number, tokens = 600, provider?: number) => Buffer.concat([
  time(1, start, 100_000), time(7, finish, 900_000),
  message(9, Buffer.concat([int(1, 1419), int(3, tokens), ...(provider === undefined ? [] : [int(6, provider)])])),
]);

test('native response speed uses completed generation boundaries, separates Vertex from subscription and excludes tool waiting', () => {
  const finish = now - 2 * 3600_000, start = finish - 10_000;
  const models = new Map([[1419, 'gemini-4-argon']]);
  const vertex = antigravityResponse(metadata(start, finish, 600, 3), '9', 'vertex-conv', models, now - 3 * 3600_000)!;
  const subscription = antigravityResponse(metadata(start - 20_000, start - 10_000, 400, 24), '10', 'sub-conv', models, now - 3 * 3600_000)!;
  assert.equal(vertex.account, 'ag2');
  assert.equal(vertex.mode, 'vertex');
  assert.equal(vertex.tokensPerSecond, 60);
  assert.equal(vertex.outputMs, 10_000);
  assert.equal(subscription.account, 'ag1');
  assert.equal(subscription.mode, 'subscription');
  assert.equal(subscription.tokensPerSecond, 40);
  const aggregate = new DialogSpeed();
  aggregate.accept(vertex); aggregate.accept(vertex); aggregate.accept(subscription);
  const intervals = aggregate.intervals(now);
  assert.equal(intervals[1].samples.length, 2);
  const row = intervals[1].samples.find(item => item.mode === 'vertex')!;
  assert.equal(row.sampleCount, 1);
  assert.equal(row.excludedSamples, 0);
  assert.equal(row.responseTokensPerSecond, 60);
  const snapshot = { samples: intervals[0].samples, intervals, nextFallbackAt: null, stale: false };
  const html = outputSpeed(snapshot, now);
  assert.match(html, /整段响应/);
  assert.match(html, /含首字等待/);
  assert.match(html, /最近 3 小时均值/);
  assert.match(html, /Vertex<i>当前<\/i><\/span><b>≈60\.0 token\/s/);
  assert.match(html, /订阅<\/span><b>≈40\.0 token\/s/);
  assert.doesNotMatch(html, /暂未提供速度读数/);
  const history = speedHistory(snapshot, 'last_three_days', 'ag1');
  const historyVertex = speedHistory(snapshot, 'last_three_days', 'ag2');
  assert.match(historyVertex, />Vertex<\/span><\/td>[\s\S]*?≈60\.0/);
  assert.match(history, />订阅<\/span><\/td>[\s\S]*?≈40\.0/);
  assert.doesNotMatch(history, /模式未知/);
});
test('missing model, unfinished or reversed times and truncated protobuf stay unavailable', () => {
  assert.equal(antigravityResponse(metadata(now - 11_000, now - 1000), '9', 'fixture', new Map(), 0), null);
  assert.equal(antigravityResponse(metadata(now - 1000, now - 11_000), '9', 'fixture', new Map([[1419, 'gemini-4-argon']]), 0), null);
  assert.equal(antigravityResponse(metadata(now - 11_000, now - 1000), '9', 'fixture', new Map([[1419, 'gemini-4-argon']]), now), null);
  assert.throws(() => decodeWire(Buffer.from([10, 8, 1])));
});

test('SQLite reader selects finished planner responses and resolves their recorded model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-agy-speed-'));
  try {
    const dir = join(home, '.gemini/antigravity-cli/conversations');
    await mkdir(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'test-conversation.db'));
    db.exec('CREATE TABLE gen_metadata (data BLOB); CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, metadata BLOB);');
    const info = message(1, Buffer.concat([int(3, 1419), message(19, Buffer.from('gemini-4-argon'))]));
    db.prepare('INSERT INTO gen_metadata VALUES (?)').run(info);
    const insert = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)');
    insert.run(1, 15, 3, metadata(now - 11_000, now - 1000));
    insert.run(2, 15, 2, metadata(now - 11_000, now - 1000));
    insert.run(3, 132, 3, metadata(now - 11_000, now - 1000));
    db.close();
    const samples = await readAntigravitySpeed(home, now);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].model, 'gemini-4-argon');
    assert.equal(samples[0].tokensPerSecond, 60);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('readAntigravityQuota caches fresh readings for 15 minutes and prunes stale CLI logs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-agy-quota-cache-'));
  try {
    const binDir = join(home, '.local/bin');
    const logDir = join(home, '.gemini/antigravity-cli/log');
    await mkdir(binDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
    const countFile = join(home, 'invocations.txt');
    const agyBin = join(binDir, 'agy');
    const payload = JSON.stringify(quota(0.82, new Date(now + 3600_000).toISOString()));
    await writeFile(agyBin, `#!/bin/sh\necho 1 >> "${countFile}"\nprintf '%s\\n' '${payload}'\n`);
    await chmod(agyBin, 0o755);
    const staleLog = join(logDir, 'cli-20261018_000000.log');
    const emptyLog = join(logDir, 'cli-20261020_000000.log');
    const freshLog = join(logDir, 'cli-20261020_120000.log');
    await writeFile(staleLog, 'old');
    const twoDaysAgo = new Date(now - 48 * 3600_000);
    await utimes(staleLog, twoDaysAgo, twoDaysAgo);
    await writeFile(emptyLog, '');
    await writeFile(freshLog, 'active');

    const first = await readAntigravityQuota(home, now);
    assert.equal(first.status, 'observed');
    assert.equal(first.windows[0].remainingPercent, 82);
    const second = await readAntigravityQuota(home, now + 60_000);
    assert.equal(second.capturedAt, first.capturedAt);
    const remainingLogs = await readdir(logDir);
    assert.deepEqual(remainingLogs, ['cli-20261020_120000.log']);

    const afterTtl = await readAntigravityQuota(home, now + ANTIGRAVITY_QUOTA_TTL_MS + 1000);
    assert.notEqual(afterTtl.capturedAt, first.capturedAt);
  } finally { await rm(home, { recursive: true, force: true }); }
});
