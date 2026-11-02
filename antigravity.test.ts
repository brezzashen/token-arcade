/** Subscription telemetry must not duplicate transcript revisions or invent unavailable counters. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAntigravityStep, readAntigravityReport } from './antigravity.ts';
import { projectReport } from './report.ts';
import { overview } from './web/overview.ts';
import { pricing } from './web/pricing.ts';

const now = Date.now();
const step = (values: Record<string, unknown> = {}) => ({ type: 'PLANNER_RESPONSE', status: 'DONE',
  step_index: 1, created_at: new Date(now - 1000).toISOString(), input_tokens: 10, cache_read_tokens: 90,
  output_tokens: 20, ...values });

test('Antigravity input includes cache once and missing output stays unavailable', () => {
  assert.deepEqual(parseAntigravityStep(step()), { at: now - 1000, input: 100, cached: 90, output: 20, model: null });
  assert.equal(parseAntigravityStep(step({ output_tokens: undefined })), null);
  assert.equal(parseAntigravityStep(step({ status: 'RUNNING' })), null);
  assert.equal(parseAntigravityStep(step({ input_tokens: -1 })), null);
});

test('canonical logs deduplicate step revisions and omit full-log copies, future and old usage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-antigravity-'));
  try {
    const logs = join(home, '.gemini/antigravity-cli/brain/session/.system_generated/logs');
    await mkdir(logs, { recursive: true });
    const rows = [step({ output_tokens: 5 }), step(),
      step({ step_index: 2, status: 'RUNNING' }), step({ step_index: 3, output_tokens: undefined }),
      step({ step_index: 4, created_at: new Date(now + 1000).toISOString() }),
      step({ step_index: 5, created_at: new Date(now - 25 * 3600_000).toISOString() })];
    await writeFile(join(logs, 'transcript.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n{');
    await writeFile(join(logs, 'transcript_full.jsonl'), JSON.stringify(step({ output_tokens: 9999 })));
    const report = await readAntigravityReport(home, now);
    const recent = report.tokens.samples[0];
    assert.equal(recent.totalTokens, 120);
    assert.equal(recent.validResponses, 1);
    assert.equal(recent.turnsWithoutUsage, 1);
    assert.equal(recent.status, 'partial');
    assert.equal(recent.recordGaps, true);
    assert.equal(recent.reasoningOutputTokens, null);
    assert.equal(report.cache.samples[0].tokenHitPercent, 90);
    assert.deepEqual(report.tokens.byModel, []);
    const publicReport = projectReport('ag1', report);
    assert.equal(publicReport.plan, 'Google AI Ultra');
    assert.equal(publicReport.issue, null);
    assert.equal(publicReport.label, 'ag1 · ultra');
    const rendered = overview([publicReport]) + pricing([publicReport]);
    assert.match(rendered, /Google AI Ultra/);
    assert.match(rendered, /暂未提供读数/);
    assert.match(rendered, /月费待确认/);
    assert.doesNotMatch(rendered, /按量计费|Vertex AI|aria-valuenow="0"/);
    assert.doesNotMatch(JSON.stringify(publicReport), /session|\.gemini|input_tokens|thinking|tool_calls/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('missing Antigravity logs preserve subscription and leave usage unknown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-antigravity-'));
  try {
    const report = await readAntigravityReport(home, now);
    assert.equal(report.quota.plan, 'Google AI Ultra');
    assert.equal(report.telemetryError, true);
    assert.ok(report.tokens.samples.every(row => row.totalTokens === null && row.status === 'unavailable'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('ag2 isolates Vertex AI records and computes real USD billing while ag1 keeps subscription quota', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-antigravity-ag2-'));
  try {
    const logs = join(home, '.gemini/antigravity-cli/brain/session/.system_generated/logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'transcript.jsonl'), JSON.stringify(step({ model: 'gemini-4-argon', input_tokens: 1_000_000, cache_read_tokens: 5_000_000, output_tokens: 100_000 })) + '\n');
    const convDir = join(home, '.gemini/antigravity-cli/conversations');
    await mkdir(convDir, { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(convDir, 'session.db'));
    db.exec('CREATE TABLE gen_metadata (data BLOB); CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, metadata BLOB);');
    // field 9 (ModelUsage) -> field 1 (enum=1419), field 3 (out=100000), field 6 (provider=3 GOOGLE_VERTEX)
    const varint = (v: number) => { const b: number[] = []; do { const p = v % 128; v = Math.floor(v / 128); b.push(p + (v ? 128 : 0)); } while (v); return Buffer.from(b); };
    const int = (f: number, v: number) => Buffer.concat([varint(f * 8), varint(v)]);
    const msg = (f: number, v: Buffer) => Buffer.concat([varint(f * 8 + 2), varint(v.length), v]);
    db.prepare('INSERT INTO gen_metadata VALUES (?)').run(msg(1, Buffer.concat([int(3, 1419), msg(19, Buffer.from('gemini-4-argon'))])));
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 3, msg(9, Buffer.concat([int(1, 1419), int(3, 100_000), int(6, 3)])));
    db.close();
    const subReport = await readAntigravityReport(home, now, { alias: 'ag1' });
    assert.equal(subReport.tokens.samples[0].totalTokens, null);
    const vertexReport = await readAntigravityReport(home, now, { alias: 'ag2' });
    assert.equal(vertexReport.tokens.samples[0].totalTokens, 6_100_000);
    // 1M uncached * $4 + 5M cached * $0.2 + 0.1M output * $20 = 4 + 1 + 2 = $7.00
    assert.ok(vertexReport.billing && Math.abs(vertexReport.billing.costUsd! - 7) < 1e-6);
    const projected = projectReport('ag2', vertexReport);
    assert.equal(projected.label, 'ag2 · vertex');
    assert.equal(projected.plan, 'Vertex AI Pay-as-you-go');
    const html = overview([projected]) + pricing([projected]);
    assert.match(html, /\$7\.00/);
    assert.match(html, /本月真实账单/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
