import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parseSpeedRollout, deduplicate, readSpeedRecords } from './speed-records.ts';
import { buildSpeedReport } from './speed-report.ts';
import { measure, spearman, statistics } from './timing.ts';
import { queryWindow } from './speed.ts';
import { creditEstimate, normalizeTier } from './speed-cost.ts';
import { prepareWeeklyQuota, weeklyQuotaStatistics, weeklyQuotaSummary } from './weekly-quota.ts';
import { calibrateQuota, estimatedQuotaStatistics } from './quota-estimate.ts';
import type { Records } from './records.ts';
import { buildReport, windowForecast } from './forecast.ts';
import type { LiveQuota, Window } from './quota.ts';
import { readRecords } from './records.ts';
import { cacheWindow } from './cache-report.ts';
import { buildTokenReport, quotaTokenConsumption, tokenWindow } from './token-report.ts';
import { StreamMeasurement, measureTrial, skippedTrial, summarizeTrials } from './benchmark-measure.ts';
import { parseBenchmarkOptions, trialSchedule } from './benchmark.ts';
import { freezeInput } from './benchmark-input.ts';
import type { BenchmarkRpc, RpcEvent } from './benchmark-rpc.ts';
import { ClaudeStreamMeasurement, claudeArgs, claudeEnvironment } from './benchmark-claude.ts';

const at = Date.parse('2026-10-01T02:00:00Z'), project = '/speed-test-project', owner = 'private-fixture-account';
const scripts = fileURLToPath(new URL('.', import.meta.url));
const diagnostics = () => ({ malformedLines: 0, unownedFiles: 0, unreadableFiles: 0, inheritedCopies: 0, duplicateTurns: 0 });
const row = (ms: number, type: string, payload: any) => ({ timestamp: new Date(ms).toISOString(), type, payload });
const meta = (id = 'root') => row(at - 30_000, 'session_meta', { id, creator_account_id: owner, timestamp: new Date(at - 30_000).toISOString() });

function turn(id = 'turn', start = at, model = 'gpt-6-astra', effort = 'high') {
  const event = (offset: number, payload: any) => row(start + offset, 'event_msg', { turn_id: id, ...payload });
  return [
    event(0, { type: 'task_started', started_at: start / 1000 }),
    row(start + 1, 'turn_context', { turn_id: id, cwd: project, model, effort }),
    row(start + 2_000, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the sheet. secret-user@example.com sk-fixture-sensitive' }] }),
    event(13_000, { type: 'item_completed', started_at_ms: start + 3_000, completed_at_ms: start + 13_000,
      item: { id: 'reason', type: 'Reasoning', raw_content: 'private-reasoning-marker' } }),
    row(start + 15_000, 'response_item', { type: 'function_call', call_id: 'call', arguments: 'private-tool-marker' }),
    row(start + 20_000, 'response_item', { type: 'function_call_output', call_id: 'call', output: 'private-output-marker' }),
    event(21_000, { type: 'item_completed', started_at_ms: start + 20_000, completed_at_ms: start + 21_000,
      item: { type: 'FileChange', changes: { 'web/src/Sheet.tsx': { diff: 'private-diff-marker' } } } }),
    row(start + 22_000, 'token_usage_record', { turn_id: id, response_id: 'response', usage: { reasoning_output_tokens: 100 } }),
    event(60_000, { type: 'item_completed', started_at_ms: start + 59_000, completed_at_ms: start + 60_000,
      item: { id: 'final', type: 'AgentMessage', phase: 'final_answer' } }),
    event(61_000, { type: 'task_complete', last_agent_message: 'Completed the frontend fix.' }),
  ];
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'remaining-range-test-'));
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: owner } }));
  return { home, close: () => rmSync(home, { recursive: true, force: true }) };
}

function rollout(home: string, rows: any[], name = 'root.jsonl', cr = false) {
  const path = join(home, name);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, rows.map((r, i) => {
    const json = JSON.stringify(r);
    return cr && i === 2 ? json.replace(',"type"', '\r,"type"') : json;
  }).join('\n') + '\n');
  return { id: 'root', rollout_path: path, cwd: project };
}

function index(home: string, rows: any[]) {
  const db = new DatabaseSync(join(home, 'state_1.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, updated_at INTEGER, creator_account_id TEXT, source TEXT, agent_path TEXT, archived INTEGER, model TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(r.id, r.rollout_path, r.cwd, Math.floor((at + 500_000) / 1000), r.owner === undefined ? owner : r.owner,
    r.source ?? 'cli', r.agent_path ?? null, r.archived ?? 0, 'gpt-6.1-sol');
  db.close();
}

async function parse(rows: any[], cr = false) {
  const f = fixture(), d = diagnostics();
  try { return { tasks: await parseSpeedRollout(rollout(f.home, rows, 'root.jsonl', cr), owner, at - 1_000, at + 500_000, d), diagnostics: d }; }
  finally { f.close(); }
}

function report(tasks: Awaited<ReturnType<typeof parse>>['tasks'], weeklyQuota?: ReturnType<typeof prepareWeeklyQuota>) {
  return buildSpeedReport(tasks, diagnostics(), { since: at - 1_000, until: at + 500_000, timezone: 'Asia/Singapore',
    project, type: 'all', fingerprint: 'fixture-hash', index: 'state_1.sqlite', details: true, weeklyQuota });
}

test('uses historical turn settings and LF anchors despite bare CR whitespace', async () => {
  const rows = [meta(), row(at - 1, 'event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', reasoning_effort: 'max' } }), ...turn()];
  const { tasks, diagnostics: d } = await parse(rows, true);
  assert.equal(d.malformedLines, 0);
  const m = measure(tasks[0], 'Asia/Singapore');
  assert.equal(m.model, 'gpt-6-astra'); assert.equal(m.effort, 'high');
  assert.ok(m.anchors.context.endsWith(':4'));
  assert.equal(m.totalMs, 58_000); assert.equal(m.reasonMs, 10_000); assert.equal(m.waitingMs, 5_000); assert.equal(m.otherMs, 43_000);
  assert.equal(m.frontend, true); assert.equal(m.repair, true);
});

test('deduplicates Reasoning items, token responses and complete turn copies', async () => {
  const rows = [meta(), ...turn()];
  rows.splice(6, 0, rows[4]); rows.splice(10, 0, rows.find(r => r.type === 'token_usage_record')!);
  const { tasks } = await parse(rows);
  const d = diagnostics(), unique = deduplicate([{ ...tasks[0], status: 'open' }, tasks[0]], d);
  assert.equal(d.duplicateTurns, 1); assert.equal(unique.length, 1); assert.equal(unique[0].status, 'complete');
  const m = measure(unique[0], 'Asia/Singapore');
  assert.equal(m.steps, 1); assert.equal(m.reasoningTokens, 100);
});

test('partitions overlapping tools and reasoning without adding background execution', async () => {
  const { tasks } = await parse([meta(), ...turn()]);
  const t = tasks[0]; t.reasoning.set('reason', [at + 10_000, at + 18_000]);
  t.execution.push([at + 2_000, at + 60_000]);
  const m = measure(t, 'Asia/Singapore');
  assert.equal(m.reasoningWaitingOverlapMs, 3_000); assert.equal(m.waitingMs, 2_000);
  assert.equal(m.reasonMs + m.waitingMs + m.otherMs, m.totalMs);
  assert.equal(m.executionWithBackgroundMs, m.totalMs); assert.ok(m.reasoningBackgroundOverlapMs > 0);
});

test('does not inflate open turns or include missing final, timing, tools, mixed effort or pending work', async () => {
  const mutations = [
    { expected: 'unfinished', apply: (rows: any[]) => rows.filter(r => r.payload.type !== 'task_complete') },
    { expected: 'missingFinalOrUser', apply: (rows: any[]) => rows.filter(r => r.payload.item?.phase !== 'final_answer') },
    { expected: 'missingReasoningTiming', apply: (rows: any[]) => rows.map(r => r.payload.item?.type === 'Reasoning' ? { ...r, payload: { ...r.payload, started_at_ms: undefined } } : r) },
    { expected: 'unmatchedTools', apply: (rows: any[]) => rows.filter(r => r.payload.type !== 'function_call_output') },
    { expected: 'mixedOrUnknownModel', apply: (rows: any[]) => [...rows, row(at + 62_000, 'turn_context', { turn_id: 'turn', model: 'gpt-6-astra', effort: 'max' })] },
    { expected: 'reportedPending', apply: (rows: any[]) => rows.map(r => r.payload.type === 'task_complete' ? { ...r, payload: { ...r.payload, last_agent_message: '尚未部署，等待确认。' } } : r) },
  ];
  for (const { expected, apply } of mutations) {
    const { tasks } = await parse([meta(), ...apply(turn())]), r = report(tasks);
    assert.equal(r.completedCount, 0); assert.equal(r.exclusions[expected], 1); assert.equal(r.overall.meanTotalMs, null);
  }
});

test('excludes inherited starts and ignores idle gaps between separately completed turns', async () => {
  const inherited = turn('inherited'); inherited[0].payload.started_at = (at - 3_600_000) / 1000;
  const skipped = await parse([meta(), ...inherited]);
  assert.equal(skipped.tasks.length, 0); assert.equal(skipped.diagnostics.inheritedCopies, 1);
  const { tasks } = await parse([meta(), ...turn('one'), ...turn('two', at + 200_000, 'gpt-6.1-sol', 'max')]);
  const r = report(tasks);
  assert.equal(r.completedCount, 2); assert.equal(r.overall.meanTotalMs, 58_000);
  assert.deepEqual(r.modelGroups.map(g => g.key), ['gpt-6-astra/high', 'gpt-6.1-sol/max']);
});

test('handles local calendar windows, rolling windows and DST without assuming 24-hour calendar days', () => {
  const now = Date.parse('2026-10-01T10:57:00Z');
  assert.equal(queryWindow({}, now).since, Date.parse('2026-09-29T16:00:00Z'));
  assert.equal(queryWindow({ hours: '24' }, now).since, now - 86_400_000);
  const spring = queryWindow({ days: '2', timezone: 'America/New_York' }, Date.parse('2026-03-09T16:00:00Z'));
  assert.equal(spring.since, Date.parse('2026-03-08T05:00:00Z'));
  assert.throws(() => queryWindow({ days: '2', hours: '24' }, now));
  assert.throws(() => queryWindow({ days: '0' }, now));
  assert.throws(() => queryWindow({ until: 'invalid' }, now));
});

test('computes pooled segment duration, medians and rank correlations with ties', async () => {
  const { tasks } = await parse([meta(), ...turn()]), m = measure(tasks[0], 'Asia/Singapore');
  const s = statistics([m, { ...m, steps: 3, reasonMs: 30_000, totalMs: 100_000 }]);
  assert.equal(s.pooledMeanStepMs, 10_000); assert.equal(s.medianTotalMs, 79_000);
  assert.equal(spearman([1, 1, 3], [2, 2, 5]), 1); assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
});

function snapshot(folder: string): any[] {
  return readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? snapshot(path) : [{ path, size: statSync(path).size, modified: statSync(path).mtimeMs }];
  });
}

test('finds archived updated roots, rejects other owners/subagents, and prints no private content or saved statistics', async () => {
  const f = fixture();
  try {
    const root = rollout(f.home, [meta(), ...turn()], 'archived_sessions/old.jsonl');
    const wrong = rollout(f.home, [meta('another-owner'), ...turn()], 'wrong.jsonl');
    index(f.home, [root, { ...root, id: 'child', agent_path: '/root/child' }, { ...root, id: 'unknown', owner: null }, wrong]);
    const records = await readSpeedRecords(f.home, owner, at - 1_000, at + 500_000, project);
    assert.equal(records.tasks.length, 1); assert.equal(records.diagnostics.excludedSubagents, 1); assert.equal(records.diagnostics.unownedFiles, 1);
    assert.equal(records.diagnostics.unknownOwnership, 1);
    const before = snapshot(f.home);
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'speed.ts'),
      '--home', f.home, '--project', project, '--since', new Date(at - 1_000).toISOString(), '--until', new Date(at + 500_000).toISOString(), '--details'],
    { encoding: 'utf8', env: { ...process.env, PATH: '/no-quota-cli-available' } });
    assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).completedCount, 1);
    for (const privateText of [owner, 'secret-user@example.com', 'sk-fixture-sensitive', 'private-reasoning-marker', 'private-tool-marker', 'private-output-marker', 'private-diff-marker']) {
      assert.ok(!child.stdout.includes(privateText));
    }
    assert.deepEqual(snapshot(f.home), before);
  } finally { f.close(); }
});

test('range still returns all three quota samples without writing latest.json', () => {
  const f = fixture();
  try {
    index(f.home, []);
    const bin = join(f.home, 'bin'), fake = join(f.home, 'fake-codex.ts'); mkdirSync(bin);
    writeFileSync(fake, `import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const p = JSON.parse(line); if (!p.id) continue;
  const result = p.method === 'account/read' ? { account: { type: 'chatgpt', planType: 'fixture' } }
    : p.method === 'account/rateLimits/read' ? { rateLimits: { limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+3600 } } } : {};
  process.stdout.write(JSON.stringify({ id: p.id, result })+'\\n');
}`);
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)}\n`, { mode: 0o700 });
    const before = snapshot(f.home);
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'range.ts'), '--home', f.home],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout).samples.map((s: any) => s.id), ['last_hour', 'last_three_hours', 'last_five_hours', 'today']);
    assert.deepEqual(JSON.parse(child.stdout).cache.samples.map((s: any) => [s.id, s.tokenHitPercent]),
      [['last_hour', null], ['last_three_hours', null], ['last_five_hours', null], ['today', null]]);
    assert.deepEqual(JSON.parse(child.stdout).tokens.samples.map((s: any) => [s.id, s.totalTokens]),
      [['last_hour', null], ['last_three_hours', null], ['last_five_hours', null], ['today', null]]);
    assert.equal(JSON.parse(child.stdout).windows[0].tokens, null);
    assert.equal(JSON.parse(child.stdout).windows[0].cycleTokens.quotaPercentagePoints, 20);
    assert.equal(JSON.parse(child.stdout).windows[0].cycleTokens.intervalBasis, 'resetsAt minus windowMinutes, to capture');
    assert.ok(!child.stdout.includes(owner)); assert.deepEqual(snapshot(f.home), before);
  } finally { f.close(); }
});

test('runs the CLI through a linked skill directory', () => {
  const f = fixture();
  try {
    const linked = join(f.home, 'linked-skill'); symlinkSync(scripts, linked);
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(linked, 'speed.ts'), '--help'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert.ok(child.stdout.length > 0);
  } finally { f.close(); }
});

test('cache ratios weight tokens, deduplicate responses and clip usage independently of turn starts', async () => {
  const f = fixture();
  try {
    const usage = (offset: number, response: string, input: number, cached: number) => row(at + offset, 'token_usage_record', {
      turn_id: 'turn', response_id: response, usage: { input_tokens: input, cached_input_tokens: cached },
    });
    const root = rollout(f.home, [meta(), ...turn().slice(0, 2), usage(5_000, 'before', 999, 999),
      usage(15_000, 'large', 900, 900), usage(16_000, 'large', 900, 900), usage(20_000, 'small', 100, 0),
      usage(90_000, 'future', 100, 100)]);
    index(f.home, [root]);
    const records = await readRecords(f.home, owner, at + 10_000, at + 60_000);
    const r = cacheWindow(records, at + 10_000, at + 60_000);
    assert.equal(r.tokenHitPercent, 90); assert.equal(r.responseHitPercent, 50);
    assert.equal(r.inputTokens, 1000); assert.equal(r.cachedInputTokens, 900);
    assert.equal(r.validResponses, 2); assert.equal(r.duplicateResponses, 1);
    assert.equal(r.byThread[0].threadId, 'root'); assert.equal(r.byModel[0].model, 'gpt-6-astra');
    assert.equal(cacheWindow(records, at + 10_000, at + 60_000, 'missing').tokenHitPercent, null);
  } finally { f.close(); }
});

test('cache missing fields, conflicts and zero input remain unavailable instead of becoming misses', () => {
  const response = (responseId: string | null, input: number | null, cachedInput: number | null) => ({
    responseId, input, cachedInput, at, threadId: 'root', turnId: 'turn', model: 'fixture', source: `fixture:${responseId}`,
  });
  const records: Records = { turns: [{ id: 'missing', threadId: 'root', start: at - 1, end: at + 1,
    model: 'fixture', tier: 'unknown', complete: false }], points: [], diagnostics: {}, anchors: [],
    cacheResponses: [response('valid', 100, 80), response('missing', null, null), response(null, 100, 100),
      response('conflict', 100, 100), response('conflict', 100, 50)] };
  const partial = cacheWindow(records, at - 1, at + 1);
  assert.equal(partial.tokenHitPercent, 80); assert.equal(partial.status, 'partial');
  assert.equal(partial.invalidResponses, 3); assert.equal(partial.turnsWithoutUsage, 1);
  records.cacheResponses = [response('zero', 0, 0)];
  assert.equal(cacheWindow(records, at - 1, at + 1).tokenHitPercent, null);
  assert.equal(cacheWindow(records, at - 1, at + 1).reason, 'zero_input_tokens');
  records.cacheResponses = [];
  assert.equal(cacheWindow(records, at - 1, at + 1).reason, 'missing_or_invalid_usage');
});

test('cache parser rejects invalid counters and inherited usage, includes owned subagents and ignores other accounts', async () => {
  const f = fixture();
  try {
    const usage = (id: string, input: unknown, cached: unknown, ms = at + 10_000) => row(ms, 'token_usage_record', {
      turn_id: 'turn', response_id: id, usage: { input_tokens: input, cached_input_tokens: cached },
    });
    const root = rollout(f.home, [meta(), ...turn().slice(0, 2), usage('inherited', 500, 500, at - 60_000),
      usage('valid', 100, 50), usage('excess', 100, 101), usage('missing', 100, undefined), usage('negative', -1, 0)]);
    const child = { ...rollout(f.home, [meta('child'), ...turn('child-turn').slice(0, 2), usage('child', 200, 150)], 'child.jsonl'),
      id: 'child', agent_path: '/root/child', source: 'subagent' };
    const foreign = { ...rollout(f.home, [row(at - 30_000, 'session_meta', { id: 'foreign', creator_account_id: 'other' }),
      usage('foreign', 9999, 9999)], 'foreign.jsonl'), id: 'foreign', owner: 'other' };
    index(f.home, [root, child, foreign]);
    const r = cacheWindow(await readRecords(f.home, owner, at - 120_000, at + 60_000), at - 120_000, at + 60_000);
    assert.equal(r.validResponses, 2); assert.equal(r.invalidResponses, 3);
    assert.equal(r.inputTokens, 300); assert.equal(r.cachedInputTokens, 200);
    assert.equal(r.byThread.length, 2);
  } finally { f.close(); }
});

test('cache CLI prints current-thread metadata without RPC, private text or saved reports', () => {
  const f = fixture();
  try {
    const shift = Date.now() - at - 120_000;
    const rows = [meta(), ...turn()].map(r => ({ ...r, timestamp: new Date(Date.parse(r.timestamp) + shift).toISOString(),
      payload: { ...r.payload, ...(r.type === 'session_meta' ? { timestamp: new Date(at - 30_000 + shift).toISOString() } : {}),
        ...(r.payload.type === 'task_started' ? { started_at: (at + shift) / 1000 } : {}),
        ...(r.type === 'token_usage_record' ? { usage: { input_tokens: 1000, cached_input_tokens: 750 } } : {}) } }));
    const root = rollout(f.home, rows); index(f.home, [root]);
    const db = new DatabaseSync(join(f.home, 'state_1.sqlite'));
    db.prepare('UPDATE threads SET updated_at = ?').run(Math.floor(Date.now() / 1000)); db.close();
    const before = snapshot(f.home);
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'cache.ts'),
      '--home', f.home, '--hours', '24', '--thread', 'root'],
    { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent', CODEX_THREAD_ID: 'root' } });
    assert.equal(child.status, 0, child.stderr);
    const r = JSON.parse(child.stdout);
    assert.equal(r.selected.tokenHitPercent, 75); assert.equal(r.currentThread.threadId, 'root');
    assert.ok(!child.stdout.includes(owner)); assert.ok(!child.stdout.includes('private-reasoning-marker'));
    assert.ok(!child.stdout.includes('secret-user@example.com')); assert.deepEqual(snapshot(f.home), before);
  } finally { f.close(); }
});

test('token consumption sums response usage once, includes owned subagents and conserves cache/reasoning subsets', async () => {
  const f = fixture();
  try {
    const usage = (response: string, input: number, cached: number, output: number, reasoning: number) => row(at + 30_000,
      'token_usage_record', { turn_id: 'turn', response_id: response,
        usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning } });
    const duplicate = usage('root-response', 1000, 800, 200, 150);
    const root = rollout(f.home, [meta(), ...turn().slice(0, 2), duplicate, duplicate,
      row(at + 40_000, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 999999 } } })]);
    const child = { ...rollout(f.home, [meta('child'), ...turn().slice(0, 2), usage('child-response', 500, 100, 100, 50)],
      'child.jsonl'), id: 'child', source: 'subagent' };
    index(f.home, [root, child]);
    const records = await readRecords(f.home, owner, at, at + 3600_000);
    const r = tokenWindow(records, at, at + 3600_000);
    assert.equal(r.totalTokens, 1800); assert.equal(r.inputTokens, 1500);
    assert.equal(r.cachedInputTokens, 900); assert.equal(r.uncachedInputTokens, 600);
    assert.equal(r.outputTokens, 300); assert.equal(r.reasoningOutputTokens, 200);
    assert.equal(r.visibleOutputTokens, 100); assert.equal(r.validResponses, 2);
    assert.equal(r.duplicateResponses, 1); assert.equal(r.tokensPerWallClockHour, 1800);
    assert.equal(r.activeHours, 40 / 3600); assert.equal(r.tokensPerActiveHour, 162000);
    const report = buildTokenReport(records, at, at + 3600_000, 'root');
    assert.equal(report.currentThread!.totalTokens, 1200);
    assert.equal(report.byModel[0].totalTokens, 1800);
    assert.ok(r.evidence.every(e => /\.jsonl:\d+$/.test(e)));
  } finally { f.close(); }
});

test('token usage excludes invalid/conflicting counters without mutating cache readings or inventing missing reasoning', () => {
  const response = (id: string | null, output: number | null, reasoningOutput: number | null = null) => ({
    responseId: id, input: 100, cachedInput: 80, output, reasoningOutput, at,
    threadId: 'root', turnId: 'turn', model: 'fixture', source: `fixture:${id}`,
  });
  const records: Records = { turns: [], points: [], diagnostics: {}, anchors: [], cacheResponses: [
    response('valid', 20), response('missing', null), response('conflict', 20), response('conflict', 30),
    response(null, 20), response('negative', -1),
  ] };
  const before = JSON.stringify(records);
  const r = tokenWindow(records, at - 1, at + 1);
  assert.equal(r.status, 'partial'); assert.equal(r.totalTokens, 120);
  assert.equal(r.invalidResponses, 4); assert.equal(r.reasoningOutputTokens, null);
  assert.equal(r.visibleOutputTokens, null); assert.equal(r.reasoningResponses, 0);
  assert.equal(cacheWindow(records, at - 1, at + 1).inputTokens, 400);
  assert.equal(JSON.stringify(records), before);
  assert.equal(tokenWindow(records, at + 1, at + 2).totalTokens, null);
  records.cacheResponses = [response('zero', 0, 0)];
  records.cacheResponses[0].input = 0; records.cacheResponses[0].cachedInput = 0;
  assert.equal(tokenWindow(records, at - 1, at + 1).totalTokens, 0);
  records.diagnostics.unreadableFiles = 1;
  assert.equal(tokenWindow(records, at - 1, at + 1).status, 'partial');
});

test('token parser rejects unsafe outputs and invalid reasoning without treating missing output as zero', async () => {
  const f = fixture();
  try {
    const usages = [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 20].map((output, i) => row(at + 10_000 + i,
      'token_usage_record', { turn_id: 'turn', response_id: `response-${i}`,
        usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: output, reasoning_output_tokens: 21 } }));
    index(f.home, [rollout(f.home, [meta(), ...turn().slice(0, 2), ...usages])]);
    const r = tokenWindow(await readRecords(f.home, owner, at, at + 60_000), at, at + 60_000);
    assert.equal(r.totalTokens, 120); assert.equal(r.invalidResponses, 4);
    assert.equal(r.reasoningOutputTokens, null);
  } finally { f.close(); }
});

test('token burn uses exact quota-sample extensions and reset clipping while comparison windows stay fixed', () => {
  const { live, records } = rangeFixture();
  records.points[0].at = at - 5400_000;
  records.points.push({ ...live.windows[0], at: at - 600_000, used: live.windows[0].used - 1 });
  records.turns[0].start = at - 5400_000;
  const addResponse = (id: string, offset: number) => ({ responseId: id, input: 100, cachedInput: 80,
    output: 20, reasoningOutput: 10, at: at + offset, threadId: 'root', turnId: 'sol', model: 'gpt-6.1-sol', source: id });
  records.cacheResponses = [addResponse('old', -7000_000), addResponse('extended', -5000_000), addResponse('recent', -500_000)];
  const window = windowForecast(live.windows[0], live, records, 1);
  assert.equal(window.sampleBasis, 'extended_current_cycle_sample');
  const tokens = quotaTokenConsumption(records, window)!;
  assert.equal(tokens.start, window.sampleStart); assert.equal(tokens.end, window.sampleEnd);
  assert.equal(tokens.totalTokens, 240); assert.equal(tokens.quotaPercentagePoints, window.samplePercentagePoints);
  assert.equal(tokens.tokensPerQuotaPercentagePoint, 40);
  const report = buildTokenReport(records, at - 7200_000, at);
  assert.equal(report.samples[0].totalTokens, 120); assert.equal(report.samples[2].totalTokens, 360);
  const resetWindow = { ...live.windows[0], reset: live.windows[0].reset + 60_000 };
  const clipped = { ...records, points: [{ ...resetWindow, at: at - 1000_000, used: resetWindow.used - 1 }] };
  const reset = quotaTokenConsumption(clipped, windowForecast(resetWindow, live, clipped, 1))!;
  assert.equal(reset.totalTokens, 120); assert.equal(reset.quotaPercentagePoints, 1);
  const flat = quotaTokenConsumption(records, { ...window, samplePercentagePoints: 0 })!;
  assert.equal(flat.totalTokens, 240); assert.equal(flat.tokensPerQuotaPercentagePoint, null);
});

function rangeFixture(model = 'gpt-6.1-sol', delta = 6) {
  const window: Window = { key: 'codex:primary', bucket: 'codex', slot: 'primary',
    used: 7, minutes: 10080, reset: at + 86400_000 };
  const live: LiveQuota = { at, accountId: owner, fingerprint: 'fixture', plan: 'fixture',
    windows: [window], extras: [], resetCount: null };
  const records: Records = { turns: [{ id: 'sol', start: at - 3600_000, end: at,
    model, tier: 'priority', complete: true }],
    points: [{ ...window, used: window.used - delta, at: at - 3600_000, source: 'fixture:1' }],
    diagnostics: {}, anchors: [] };
  return { window, live, records };
}

test('range forecasts Sol and other owned models instead of requiring Astra activity', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'unknown']) {
    const { live, records } = rangeFixture(model);
    const report = buildReport(live, records, at - 7200_000, 'Asia/Singapore');
    assert.equal(report.dashboard.status, 'estimated');
    assert.equal(report.dashboard.text, '预计剩余开发时间：约 15 小时 30 分钟');
    assert.equal(report.today.activeHours, 1);
    assert.equal(report.today.agentHours, 1);
    assert.equal(report.today.astraActiveHours, model === 'gpt-6-astra' ? 1 : 0);
    for (const sample of report.samples) {
      const w = sample.windows[0];
      assert.equal(w.status, 'estimated');
      assert.ok('sampleByModel' in w);
      assert.deepEqual(w.sampleByModel, [{ model, activeHours: 1 }]);
      assert.equal(w.workload, model === 'unknown' ? 'current mixed workload' : `${model} workload`);
      assert.equal(w.samplePercentagePoints, 6);
    }
  }
});

test('range unions parallel model activity while preserving summed agent hours and unknown tiers', () => {
  const { window, live, records } = rangeFixture();
  records.turns.push({ ...records.turns[0], id: 'astra', model: 'gpt-6-astra', tier: 'unknown' });
  const result = windowForecast(window, live, records);
  assert.ok('sampleAgentHours' in result);
  assert.equal(result.sampleActiveHours, 1);
  assert.equal(result.sampleAgentHours, 2);
  assert.equal(result.activeHours, 15.5);
  assert.equal(result.workload, 'current mixed workload');
  assert.deepEqual(result.sampleByRecordedTier, [{ tier: 'priority', activeHours: 1 }, { tier: 'unknown', activeHours: 1 }]);
});

test('range preserves low-consumption samples and reports the quota resolution threshold', () => {
  for (const delta of [0, 2]) {
    const { window, live, records } = rangeFixture('gpt-6.1-sol', delta);
    const result = windowForecast(window, live, records);
    assert.ok('reasonCode' in result && 'samplePercentagePoints' in result);
    assert.equal(result.status, 'calibrating');
    assert.equal(result.reasonCode, 'insufficient_quota_delta');
    assert.equal(result.sampleActiveHours, 1);
    assert.equal(result.samplePercentagePoints, delta);
    assert.equal(result.sampleStart, new Date(at - 3600_000).toISOString());
    assert.equal(result.sampleEnd, new Date(at).toISOString());
    assert.equal('activeHours' in result, false);
  }
});

test('range distinguishes missing snapshots, no activity and short activity without fabricating time', () => {
  for (const scenario of ['insufficient_quota_snapshots', 'no_active_time', 'insufficient_active_time']) {
    const { window, live, records } = rangeFixture();
    if (scenario === 'insufficient_quota_snapshots') records.points = [];
    if (scenario === 'no_active_time') records.turns = [];
    if (scenario === 'insufficient_active_time') records.turns[0].start = at - 899_000;
    const result = windowForecast(window, live, records);
    assert.ok('reasonCode' in result);
    assert.equal(result.status, 'calibrating');
    assert.equal(result.reasonCode, scenario);
    assert.equal('activeHours' in result, false);
  }
  const { window, live, records } = rangeFixture();
  records.turns[0].start = at - 900_000;
  assert.equal(windowForecast(window, live, records).status, 'estimated');
  records.points[0].at = at;
  const sameTime = windowForecast(window, live, records);
  assert.ok('reasonCode' in sameTime);
  assert.equal(sameTime.reasonCode, 'insufficient_quota_snapshots');
});

test('range extends insufficient lookbacks using current-cycle samples and clips recorded activity', () => {
  const { window, live, records } = rangeFixture();
  records.points[0].at = at - 7200_000;
  records.points.push({ ...window, used: 6, at: at - 1800_000 });
  records.turns[0].start = at - 7200_000;
  records.turns[0].end = at - 900_000;
  const result = windowForecast(window, live, records);
  assert.ok('sampleBasis' in result);
  assert.equal(result.sampleBasis, 'extended_current_cycle_sample');
  assert.equal(result.sampleActiveHours, 1.75);
  assert.equal(result.samplePercentagePoints, 6);
  assert.equal(result.sampleWallClockMinutes, 120);
  assert.equal(result.sampleStart, new Date(at - 7200_000).toISOString());
  assert.equal(result.activeHours, 27.13);
});

test('range keeps quota cycles and windows separate and refuses regressed live readings', () => {
  const { window, live, records } = rangeFixture();
  records.points[0].reset -= 10080 * 60_000;
  assert.equal(windowForecast(window, live, records).status, 'calibrating');
  records.points[0].reset = window.reset;
  records.points[0].used = 8;
  assert.equal(windowForecast(window, live, records).status, 'calibrating');
  records.points[0].used = 1;
  live.windows.push({ ...window, key: 'codex:secondary', slot: 'secondary', minutes: 300 });
  const report = buildReport(live, records, at - 7200_000, 'Asia/Singapore');
  assert.equal(report.dashboard.status, 'calibrating');
  assert.deepEqual(report.windows.map(w => w.status), ['estimated', 'calibrating']);
  live.windows[1].used = 100;
  assert.equal(buildReport(live, records, at - 7200_000, 'Asia/Singapore').dashboard.remainingMinutes, 0);
});

const fullUsage = { input_tokens: 1_000_000, cached_input_tokens: 500_000,
  output_tokens: 100_000, reasoning_output_tokens: 100 };

function pricedTurn(id = 'turn', tier: string | null = 'default', start = at) {
  return turn(id, start, 'gpt-6.1-sol', 'high').map(r => r.type === 'turn_context'
    ? { ...r, payload: { ...r.payload, service_tier: tier ?? undefined } }
    : r.type === 'token_usage_record' ? { ...r, payload: { ...r.payload, usage: { ...fullUsage } } } : r);
}

test('separates fast aliases, Standard and unknown tiers; discounts cached input and never double-charges reasoning', async () => {
  for (const tier of ['default', 'standard', 'priority', 'fast', undefined, 'auto']) {
    const { tasks } = await parse([meta(), ...pricedTurn('turn', tier ?? null)]);
    const m = measure(tasks[0], 'Asia/Singapore'), cost = creditEstimate(m);
    const mode = normalizeTier(tier ?? 'unknown');
    assert.equal(m.speedMode, mode); assert.equal(m.speedBasis, tier === undefined ? 'unknown' : 'request');
    assert.equal(cost.credits, mode === 'standard' ? 51.25 : mode === 'fast' ? 102.5 : null);
    assert.deepEqual(m.tokenUsage, { input: 1_000_000, cachedInput: 500_000, output: 100_000 });
  }
});

test('uses the historical tier before the interval and settings applied after context but before inference', async () => {
  const prior = row(at - 120_000, 'event_msg', { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } });
  const oldMeta = meta(); oldMeta.timestamp = new Date(at - 130_000).toISOString(); oldMeta.payload.timestamp = oldMeta.timestamp;
  const inherited = await parse([oldMeta, prior, ...pricedTurn('turn', null)]);
  assert.equal(measure(inherited.tasks[0], 'Asia/Singapore').speedMode, 'fast');
  const rows = pricedTurn();
  rows.splice(2, 0, row(at + 1.5, 'event_msg', { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } }));
  const updated = await parse([meta(), ...rows]);
  assert.equal(measure(updated.tasks[0], 'Asia/Singapore').speedMode, 'fast');
});

test('deduplicates full token usage and preserves unavailable costs without losing timing samples', async () => {
  const rows = pricedTurn(); rows.splice(9, 0, rows.find(r => r.type === 'token_usage_record')!);
  const parsed = await parse([meta(), ...rows]);
  assert.equal(creditEstimate(measure(parsed.tasks[0], 'Asia/Singapore')).credits, 51.25);
  const variants = [
    { ...fullUsage, cached_input_tokens: 1_000_001 }, { ...fullUsage, output_tokens: undefined },
    { ...fullUsage, input_tokens: -1 },
  ];
  for (const usage of variants) {
    const { tasks } = await parse([meta(), ...pricedTurn().map(r => r.type === 'token_usage_record'
      ? { ...r, payload: { ...r.payload, usage } } : r)]);
    const r = report(tasks);
    assert.equal(r.completedCount, 1); assert.equal(r.speedGroups[0].cost.meanEstimatedCredits, null);
    assert.equal(r.speedGroups[0].cost.unavailableReasons.missing_or_invalid_token_usage, 1);
  }
});

test('served tiers override requests, mixed/partial tier coverage never produces a false cost estimate', async () => {
  const rows = pricedTurn('turn', 'priority').map(r => r.type === 'token_usage_record'
    ? { ...r, payload: { ...r.payload, service_tier: 'default' } } : r);
  const served = await parse([meta(), ...rows]), m = measure(served.tasks[0], 'Asia/Singapore');
  assert.equal(m.speedMode, 'standard'); assert.equal(m.speedBasis, 'response');
  assert.equal(creditEstimate(m).credits, 51.25);
  for (const tier of ['fast', undefined]) {
    const extra = row(at + 23_000, 'token_usage_record', { turn_id: 'turn', response_id: 'response-2', usage: fullUsage, service_tier: tier });
    const extended = [...rows]; extended.splice(9, 0, extra);
    const parsed = await parse([meta(), ...extended]), mixed = measure(parsed.tasks[0], 'Asia/Singapore');
    assert.equal(mixed.speedMode, tier ? 'mixed' : 'unknown'); assert.equal(creditEstimate(mixed).credits, null);
  }
  const changed = [...pricedTurn()]; changed.splice(9, 0, row(at + 23_000, 'event_msg', {
    type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } }));
  const mixed = await parse([meta(), ...changed]);
  assert.equal(measure(mixed.tasks[0], 'Asia/Singapore').speedMode, 'mixed');
});

test('compares only the same model/effort/tier basis and reports missing comparison cohorts', async () => {
  const { tasks } = await parse([meta(), ...pricedTurn('standard'), ...pricedTurn('fast', 'priority', at + 200_000)]);
  const r = report(tasks), comparison = r.speedComparisons[0];
  assert.equal(r.speedGroups.length, 2); assert.equal(comparison.status, 'available');
  assert.equal(comparison.meanCompletionSpeedup, 1); assert.equal(comparison.estimatedCreditRatio, 2);
  const single = report(tasks.slice(0, 1)).speedComparisons[0];
  assert.equal(single.status, 'insufficient_speed_samples'); assert.equal(single.meanCompletionSpeedup, null);
  assert.equal(single.estimatedCreditRatio, null);
});

test('Ultrafast uses the Astra rate and multiplier and cannot be inferred from reasoning effort ultra', async () => {
  const rows = pricedTurn('turn', 'ultrafast').map(r => r.type === 'turn_context'
    ? { ...r, payload: { ...r.payload, model: 'gpt-6-astra', effort: 'ultra' } } : r);
  const { tasks } = await parse([meta(), ...rows]), m = measure(tasks[0], 'Asia/Singapore');
  assert.equal(m.speedMode, 'ultrafast'); assert.equal(creditEstimate(m).credits, 1575);
  assert.equal(creditEstimate({ ...m, model: 'gpt-6.1-sol' }).reason, 'unsupported_ultrafast_rate');
  assert.equal(creditEstimate({ ...m, model: 'unknown-model' }).reason, 'unsupported_model_rate');
  const unknown = await parse([meta(), ...turn('turn', at, 'gpt-6.1-sol', 'ultra')]);
  assert.equal(measure(unknown.tasks[0], 'Asia/Singapore').speedMode, 'unknown');
});

const weekReset = at + 3 * 86_400_000;
function weeklyRecords(): Records {
  return { turns: [{ id: 'turn', start: at, end: at + 61_000, model: 'gpt-6.1-sol', tier: 'priority', complete: true }],
    points: [10, 12].map((used, i) => ({ key: 'codex:primary', bucket: 'codex', slot: 'primary',
      used, minutes: 10080, reset: weekReset, at: at + (i ? 59_000 : 3_000), source: `/fixture.jsonl:${i + 1}` })),
    diagnostics: { unreadableFiles: 0, malformedLines: 0 }, anchors: [] };
}

test('weekly quota is a full-quota percentage-point delta, never converted credits or remaining-quota share', async () => {
  const { tasks } = await parse([meta(), ...pricedTurn('turn', 'priority')]);
  const m = measure(tasks[0], 'Asia/Singapore'), quota = prepareWeeklyQuota(weeklyRecords(), at, at + 100_000);
  const w = weeklyQuotaStatistics([m], quota).windows[0];
  assert.equal(w.meanPercentagePoints, 2); assert.equal(w.observedTasks, 1);
  assert.equal(w.observations[0].startEvidence, '/fixture.jsonl:1');
  assert.equal(weeklyQuotaSummary(quota).windows[0].samplePercentagePoints, 2);
  assert.equal(creditEstimate(m).credits, 102.5);
});

test('overlapping non-engineering or subagent turns block weekly quota attribution', async () => {
  const { tasks } = await parse([meta(), ...pricedTurn()]), m = measure(tasks[0], 'Asia/Singapore');
  const records = weeklyRecords();
  records.turns.push({ ...records.turns[0], id: 'other-account-turn', start: at + 10_000, end: at + 20_000 });
  const w = weeklyQuotaStatistics([m], prepareWeeklyQuota(records, at, at + 100_000)).windows[0];
  assert.equal(w.meanPercentagePoints, null); assert.equal(w.unavailableReasons.overlapping_account_turns, 1);
  assert.equal(weeklyQuotaSummary(prepareWeeklyQuota(records, at, at + 100_000)).windows[0].samplePercentagePoints, 2);
});

test('weekly quota keeps cycles/windows separate and excludes old-cycle task samples', async () => {
  const { tasks } = await parse([meta(), ...pricedTurn()]), m = measure(tasks[0], 'Asia/Singapore');
  const records = weeklyRecords(), day = 86_400_000;
  records.points.push(...records.points.map(p => ({ ...p, reset: weekReset + 7 * day, at: p.at + 4 * day, used: p.used - 10 })));
  records.points.push(...records.points.slice(0, 2).map(p => ({ ...p, key: 'another:primary', bucket: 'another' })));
  records.points.push({ ...records.points[0], key: 'codex:secondary', minutes: 300 });
  const quota = prepareWeeklyQuota(records, at, at + 5 * day), summary = weeklyQuotaSummary(quota);
  assert.equal(summary.windows.length, 2);
  assert.deepEqual(summary.windows.map(w => w.samplePercentagePoints), [2, 2]);
  const latest = weeklyQuotaStatistics([m], quota).windows.find(w => w.window === 'codex:primary')!;
  assert.equal(latest.meanPercentagePoints, null); assert.equal(latest.unavailableReasons.outside_current_weekly_cycle, 1);
});

test('rounded zero quota deltas, unreadable records, missing turn intervals and snapshots remain unavailable', async () => {
  const { tasks } = await parse([meta(), ...pricedTurn()]), m = measure(tasks[0], 'Asia/Singapore');
  const scenarios = [
    { reason: 'below_snapshot_resolution', mutate: (r: Records) => { r.points[1].used = r.points[0].used; } },
    { reason: 'incomplete_account_records', mutate: (r: Records) => { r.diagnostics.unreadableFiles = 1; } },
    { reason: 'incomplete_account_records', mutate: (r: Records) => { r.diagnostics.malformedLines = 1; } },
    { reason: 'missing_account_turn_interval', mutate: (r: Records) => { r.turns = []; } },
    { reason: 'insufficient_within_turn_snapshots', mutate: (r: Records) => { r.points.pop(); } },
  ];
  for (const { reason, mutate } of scenarios) {
    const records = weeklyRecords(); mutate(records);
    const w = weeklyQuotaStatistics([m], prepareWeeklyQuota(records, at, at + 100_000)).windows[0];
    assert.equal(w.meanPercentagePoints, null); assert.equal(w.unavailableReasons[reason], 1);
  }
  assert.equal(weeklyQuotaStatistics([m]).reason, 'no_weekly_snapshots');
});

test('weekly quota rejects terminal regressions and does not present partial group coverage as its full mean', async () => {
  const { tasks } = await parse([meta(), ...pricedTurn()]), m = measure(tasks[0], 'Asia/Singapore');
  const records = weeklyRecords(); records.points.push({ ...records.points[1], at: at + 59_500, used: 11 });
  const quota = prepareWeeklyQuota(records, at, at + 100_000);
  assert.equal(weeklyQuotaSummary(quota).windows[0].samplePercentagePoints, null);
  assert.equal(weeklyQuotaSummary(quota).status, 'unavailable');
  assert.equal(weeklyQuotaStatistics([m], quota).windows[0].unavailableReasons.terminal_quota_regression, 1);
  const partial = weeklyQuotaStatistics([m, { ...m, id: 'missing' }], prepareWeeklyQuota(weeklyRecords(), at, at + 100_000)).windows[0];
  assert.equal(partial.meanPercentagePoints, null); assert.equal(partial.observedTasks, 1);
  assert.equal(partial.observedTotalPercentagePoints, 2);
});

test('speed report compares weekly percentages independently from legacy credit ratios', async () => {
  const { tasks } = await parse([meta(), ...pricedTurn(), ...pricedTurn('fast', 'priority', at + 200_000)]);
  const records = weeklyRecords();
  records.turns.push({ ...records.turns[0], id: 'fast', start: at + 200_000, end: at + 261_000 });
  records.points.push(...records.points.map(p => ({ ...p, at: p.at + 200_000, used: p.used === 10 ? 12 : 18 })));
  const r = report(tasks, prepareWeeklyQuota(records, at, at + 500_000));
  const comparison = r.speedComparisons[0];
  assert.equal(comparison.estimatedCreditRatio, 2);
  assert.equal(comparison.weeklyQuota[0].standardMeanPercentagePoints, 2);
  assert.equal(comparison.weeklyQuota[0].fastMeanPercentagePoints, 6);
  assert.equal(comparison.weeklyQuota[0].quotaConsumptionRatio, 3);
  assert.equal(r.overall.weeklyQuota.windows[0].meanPercentagePoints, 4);
});

test('calibrates weekly percentages with subscription speed weights instead of purchased-credit multipliers', async () => {
  const rows = [...pricedTurn(), ...pricedTurn('fast', 'priority', at + 200_000)]
    .map(r => r.type === 'token_usage_record' && r.payload.turn_id === 'fast'
      ? { ...r, payload: { ...r.payload, response_id: 'fast-response' } } : r);
  const { tasks } = await parse([meta(), ...rows]), records = weeklyRecords();
  records.points.push({ ...records.points[1], at: at + 259_000, used: 18 });
  const quota = prepareWeeklyQuota(records, at, at + 500_000);
  quota.calibration = calibrateQuota(quota, tasks, diagnostics());
  const standard = estimatedQuotaStatistics([measure(tasks[0], 'Asia/Singapore')], quota.calibration).windows[0];
  const fast = estimatedQuotaStatistics([measure(tasks[1], 'Asia/Singapore')], quota.calibration).windows[0];
  assert.equal(standard.meanDisplay, '2.29%'); assert.equal(fast.meanDisplay, '5.71%');
  assert.equal(fast.meanEstimatedPercentagePoints! / standard.meanEstimatedPercentagePoints!, 2.5);
  assert.equal(quota.calibration.windows[0].recordedResponses, 2);
  assert.equal(standard.totalEstimatedPercentagePoints! + fast.totalEstimatedPercentagePoints!, 8);
  const comparison = report(tasks, quota).speedComparisons[0].weeklyQuota[0];
  assert.equal(comparison.estimatedQuotaConsumptionRatio, 2.5);
});

test('calibration deduplicates account responses, discloses unknown speed assumptions and retains estimated values with incomplete logs', async () => {
  const { tasks } = await parse([meta(), ...pricedTurn('turn', null)]), records = weeklyRecords();
  const quota = prepareWeeklyQuota(records, at, at + 100_000);
  const calibration = calibrateQuota(quota, [tasks[0], { ...tasks[0], id: 'inherited-copy' }], { unreadableFiles: 2 });
  assert.equal(calibration.windows[0].recordedResponses, 1);
  assert.equal(calibration.windows[0].assumedSpeedResponses, 1);
  assert.equal(calibration.diagnostics.unreadableFiles, 2);
  const m = measure(tasks[0], 'Asia/Singapore');
  assert.equal(estimatedQuotaStatistics([m], calibration).windows[0].meanEstimatedPercentagePoints, null);
  assert.equal(estimatedQuotaStatistics([{ ...m, speedMode: 'standard' }], calibration).windows[0].meanDisplay, '2.00%');
});

test('quota estimates retain tiny positive costs and never invent estimates without a quota delta', async () => {
  const { tasks } = await parse([meta(), ...pricedTurn()]), m = measure(tasks[0], 'Asia/Singapore');
  const records = weeklyRecords(), quota = prepareWeeklyQuota(records, at, at + 100_000);
  const calibration = calibrateQuota(quota, tasks, diagnostics());
  calibration.windows[0].percentagePointsPerWeight = 1e-9;
  assert.equal(estimatedQuotaStatistics([m], calibration).windows[0].meanDisplay, '<0.01%');
  records.points[1].used = records.points[0].used;
  const zero = calibrateQuota(prepareWeeklyQuota(records, at, at + 100_000), tasks, diagnostics());
  assert.equal(zero.windows[0].reason, 'insufficient_quota_delta');
  assert.equal(estimatedQuotaStatistics([m], zero).windows[0].meanDisplay, 'Unavailable');
});

test('account token calibration includes subagents while speed cohorts continue to exclude them', async () => {
  const f = fixture();
  try {
    const root = rollout(f.home, [meta(), ...pricedTurn()]);
    const child = { ...rollout(f.home, [meta('child'), ...pricedTurn('child-turn')], 'child.jsonl'), id: 'child' };
    index(f.home, [root, { ...child, agent_path: '/root/child', source: 'subagent' }]);
    const speed = await readSpeedRecords(f.home, owner, at - 1_000, at + 500_000, project);
    const account = await readSpeedRecords(f.home, owner, at - 1_000, at + 500_000, undefined, { includeSubagents: true });
    assert.equal(speed.tasks.length, 1); assert.equal(account.tasks.length, 2);
    assert.equal(account.diagnostics.calibrationFiles, 2); assert.equal(account.diagnostics.excludedSubagents, 0);
  } finally { f.close(); }
});

function streamFixture(outputMs = 4000) {
  const m = new StreamMeasurement(2000);
  m.accept({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'Code source.ts:5 ' } }, 3000);
  m.accept({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'x'.repeat(4000) } }, 3000 + outputMs);
  const event = { method: 'rawResponse/completed', params: { responseId: 'response', usage: {
    inputTokens: 3000, cachedInputTokens: 2000, outputTokens: 1000, reasoningOutputTokens: 200 }, usageMetadata: null } };
  m.accept(event, 3100 + outputMs); m.accept(event, 3100 + outputMs);
  return m;
}

test('live throughput uses provider visible tokens, not characters, and separates first text from elapsed time', () => {
  const report = streamFixture().finish(9000);
  assert.equal(report.status, 'ok'); assert.equal(report.visibleOutputTokens, 800);
  assert.equal(report.visibleTokensPerSecond, 200); assert.equal(report.firstTextMs, 1000);
  assert.equal(report.outputMs, 4000); assert.equal(report.elapsedMs, 7000);
  assert.equal(report.endToEndVisibleTokensPerSecond, 800 / 7);
  assert.equal(report.reasoningOutputTokens, 200); assert.equal(report.cachedInputTokens, 2000);
  assert.equal(report.hasSourceCitation, true); assert.equal(report.servedTier, null);
  assert.ok(!JSON.stringify(report).includes('Code source.ts'));
});

test('missing usage, single chunks, tool calls, reroutes and multiple responses never become speed samples', () => {
  const missing = streamFixture(); missing.responses.clear();
  const single = streamFixture(); single.chunks = 1;
  const invalid = streamFixture(); invalid.responses.get('response')!.usage!.reasoningOutputTokens = 1001;
  invalid.accept({ method: 'rawResponse/completed', params: { responseId: 'response', usage: invalid.responses.get('response')!.usage } }, 8000);
  const multiple = streamFixture(); multiple.responses.set('second', multiple.responses.get('response')!);
  const tool = streamFixture(); tool.accept({ method: 'item/started', params: { item: { type: 'commandExecution' } } }, 4000);
  const reroute = streamFixture(); reroute.accept({ method: 'model/rerouted', params: {} }, 4000);
  for (const m of [missing, single, invalid, multiple, tool, reroute]) {
    const result = m.finish(9000); assert.equal(result.status, 'unavailable'); assert.equal(result.visibleTokensPerSecond, null);
  }
  assert.equal(streamFixture().finish(9000, 'failed').reason, 'turn_failed');
});

test('benchmark runs each model/mode once, keeps Claude Standard only, and rejects repeats or excessive budgets', () => {
  const options = parseBenchmarkOptions({}), schedule = trialSchedule(options);
  assert.equal(schedule.length, 9); assert.equal(options.effort, 'high');
  for (const model of options.models) {
    const samples = schedule.filter(t => t.model === model);
    assert.deepEqual(new Set(samples.map(t => t.mode)), new Set(model.startsWith('claude-') ? ['standard'] : ['standard', 'fast']));
    assert.ok(samples.every(t => t.round === 1));
  }
  for (const values of [{ rounds: '0' }, { rounds: '2' }, { rounds: '6' }, { 'claude-budget-usd': '0.21' }, { 'timeout-seconds': '301' }, { mode: 'auto' },
    { models: 'gpt-6-sol,gpt-6-sol' }, { models: 'gpt-unknown' }, { effort: 'ultra' }]) {
    assert.throws(() => parseBenchmarkOptions(values));
  }
});

test('benchmark freezes actual source lines and README once, exposes only hashes, and rejects escaped paths', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'benchmark-input-'));
  try {
    const source = 'export function useful(value: number) { return value + 1; }\n'.repeat(30);
    writeFileSync(join(projectDir, 'source.ts'), source); writeFileSync(join(projectDir, 'README.md'), 'Real project context');
    const before = snapshot(projectDir), input = freezeInput(projectDir, 'source.ts', 2, 20);
    assert.equal(input.metadata.startLine, 2); assert.equal(input.metadata.endLine, 21);
    assert.ok(input.prompt.includes('2: export function useful')); assert.ok(input.prompt.includes('Real project context'));
    assert.deepEqual(snapshot(projectDir), before); assert.ok(!JSON.stringify(input.metadata).includes(source.trim()));
    writeFileSync(join(projectDir, 'source.ts'), source.replaceAll('+ 1', '+ 2'));
    const changed = freezeInput(projectDir, 'source.ts', 2, 20);
    assert.notEqual(input.metadata.promptSha256, changed.metadata.promptSha256);
    assert.ok(input.prompt.includes('+ 1')); assert.equal(changed.metadata.readmePath, 'README.md');
    symlinkSync(join(scripts, 'forecast.ts'), join(projectDir, 'escape.ts'));
    assert.throws(() => freezeInput(projectDir, 'escape.ts'), /outside_project/);
    assert.throws(() => freezeInput(projectDir, 'source.ts', 1000), /outside_file/);
    assert.throws(() => freezeInput(projectDir, 'source.ts', 1, 19), /between_20_and_500/);
  } finally { rmSync(projectDir, { recursive: true, force: true }); }
});

test('benchmark medians use valid paired rounds and never treat requested and served cohorts as equal', () => {
  const trial = (mode: string, round: number, outputMs: number) => ({ ...streamFixture(outputMs).finish(10_000),
    model: 'gpt-6-sol', mode, round, order: round, effort: 'medium', configuredTier: null,
    requestedTier: mode === 'fast' ? 'priority' : 'default', speedBasis: 'request' });
  const standard = trial('standard', 1, 4000), fast = trial('fast', 1, 2000);
  const standard2 = trial('standard', 2, 4000), fast2 = { ...trial('fast', 2, 1000), speedBasis: 'response' };
  const result = summarizeTrials([standard, fast, standard2, fast2,
    skippedTrial('gpt-6-sol', 'fast', 'medium', 3, 6, 'trial_timeout')]);
  assert.equal(result.comparisons[0].fastOutputSpeedRatio, 2);
  assert.equal(result.comparisons[0].pairedRounds, 1);
  assert.equal(result.groups.find(g => g.mode === 'fast')!.medianTokensPerSecond, 600);
  assert.equal(result.groups.find(g => g.mode === 'fast')!.attempted, 3);
  assert.equal(summarizeTrials([standard, fast2]).comparisons[0].fastOutputSpeedRatio, null);
});

function fakeTrialRpc(servedTier: string | null = null, finish = true) {
  const calls: { method: string; params: any }[] = [], listeners = new Set<(event: RpcEvent) => void>();
  const emit = (method: string, params: any) => listeners.forEach(l => l({ method, params: { threadId: 'benchmark', ...params } }));
  const rpc: BenchmarkRpc = {
    async call(method, params: any = {}) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'benchmark' }, model: params.model, serviceTier: params.serviceTier, reasoningEffort: 'medium' };
      if (method === 'turn/start') {
        emit('turn/started', { turn: { id: 'turn' } });
        if (finish) setTimeout(() => {
          emit('item/agentMessage/delta', { itemId: 'answer', delta: 'source.ts:1 ' });
          setTimeout(() => {
            emit('item/agentMessage/delta', { itemId: 'answer', delta: 'Analysis.' });
            emit('rawResponse/completed', { responseId: 'response', usage: { inputTokens: 1000, cachedInputTokens: 0,
              outputTokens: 100, reasoningOutputTokens: 10 }, usageMetadata: { metadata: servedTier ? { service_tier: servedTier } : {} } });
            emit('turn/completed', { turn: { id: 'turn', status: 'completed' } });
          }, 5);
        }, 1);
        return { turn: { id: 'turn' } };
      }
      return {};
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, close() {},
  };
  return { rpc, calls, listeners };
}

test('live trials set explicit ephemeral read-only settings and distinguish actual served tiers from requested modes', async () => {
  for (const [tier, expected] of [[null, 'ok'], ['priority', 'ok'], ['default', 'unavailable']] as const) {
    const f = fakeTrialRpc(tier), report = await measureTrial(f.rpc, { model: 'gpt-6-sol', mode: 'fast', effort: 'medium',
      round: 1, order: 1, timeoutMs: 1000, prompt: 'frozen source', cwd: '/project' });
    assert.equal(report.status, expected); assert.equal(report.speedBasis, tier ? 'response' : 'request');
    const start = f.calls.find(c => c.method === 'thread/start')!.params;
    assert.equal(start.ephemeral, true); assert.equal(start.sandbox, 'read-only'); assert.equal(start.serviceTier, 'priority');
    assert.equal(f.calls.find(c => c.method === 'turn/start')!.params.serviceTierForTurn, 'priority');
    assert.equal(f.calls.at(-1)!.method, 'thread/unsubscribe'); assert.equal(f.listeners.size, 0);
    if (expected === 'unavailable') assert.equal(report.visibleTokensPerSecond, null);
  }
});

test('timed-out benchmark turns are interrupted and all listeners are released', async () => {
  const f = fakeTrialRpc(null, false), report = await measureTrial(f.rpc, { model: 'gpt-6-sol', mode: 'standard', effort: 'medium',
    round: 1, order: 1, timeoutMs: 5, prompt: 'frozen source', cwd: '/project' });
  assert.equal(report.reason, 'trial_timeout'); assert.equal(report.visibleTokensPerSecond, null);
  assert.ok(f.calls.some(c => c.method === 'turn/interrupt')); assert.equal(f.listeners.size, 0);
});

test('range benchmark dry-run needs no account or model calls and writes no prompt or statistics files', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'benchmark-dry-run-'));
  try {
    writeFileSync(join(projectDir, 'source.ts'), 'export const privateSourceSentinel = 1;\n'.repeat(30));
    const before = snapshot(projectDir);
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'range.ts'),
      '--benchmark', '--dry-run', '--home', join(projectDir, 'no-auth'), '--project', projectDir, '--file', 'source.ts'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); const report = JSON.parse(child.stdout).benchmark;
    assert.equal(report.status, 'dry_run'); assert.equal(report.schedule.length, 9);
    assert.ok(!child.stdout.includes('privateSourceSentinel')); assert.deepEqual(snapshot(projectDir), before);
  } finally { rmSync(projectDir, { recursive: true, force: true }); }
});

function claudeStreamFixture(thinkingCounter: boolean) {
  const m = new ClaudeStreamMeasurement(0), event = (at: number, event: any) => m.accept({ type: 'stream_event', event }, at);
  event(1000, { type: 'message_start', message: { id: 'message', model: 'claude-opus-5-5', usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } } });
  event(1100, { type: 'content_block_start', content_block: { type: 'thinking' } });
  event(2000, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'source.ts:10 ' } });
  event(4000, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'analysis' } });
  event(4100, { type: 'message_delta', usage: { output_tokens: 400,
    ...(thinkingCounter ? { output_tokens_details: { thinking_tokens: 100 } } : {}), speed: 'standard' } });
  m.accept({ type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0.02 }, 4200);
  return m;
}

test('Claude throughput subtracts thinking counters and refuses to fabricate visible tokens when counters are missing', () => {
  const report = claudeStreamFixture(true).finish(4200, 'claude-opus-5-5');
  assert.equal(report.visibleTokensPerSecond, 150); assert.equal(report.visibleOutputTokens, 300);
  assert.equal(report.inputTokens, 350); assert.equal(report.cachedInputTokens, 200); assert.equal(report.numTurns, 1);
  assert.equal(report.estimatedCostUsd, 0.02); assert.equal(report.status, 'ok');
  const missing = claudeStreamFixture(false).finish(4200, 'claude-opus-5-5');
  assert.equal(missing.reason, 'missing_thinking_token_count'); assert.equal(missing.visibleTokensPerSecond, null);
  const wrong = claudeStreamFixture(true).finish(4200, 'claude-fable-5-1');
  assert.equal(wrong.reason, 'model_mismatch_or_unavailable');
  const repeated = claudeStreamFixture(true); repeated.result.num_turns = 2;
  assert.equal(repeated.finish(4200, 'claude-opus-5-5').reason, 'requires_one_cli_turn');
});

test('Claude launch bounds one turn and output cost without replacing the default authentication namespace', () => {
  const args = claudeArgs('claude-opus-5-5', 'low', 0.20);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value('--max-turns'), '1'); assert.equal(value('--tools'), '');
  assert.equal(value('--max-budget-usd'), '0.2'); assert.ok(args.includes('--no-session-persistence'));
  assert.equal(claudeEnvironment().CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  assert.equal(claudeEnvironment('/custom-profile').CLAUDE_CONFIG_DIR, '/custom-profile');
});
