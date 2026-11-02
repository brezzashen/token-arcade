import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bashWrittenPaths, parseClaudeTranscript, projectSlug, readClaudeAccountId, readClaudeRecords } from './claude-records.ts';
import { buildSpeedReport } from './speed-report.ts';
import { measure } from './timing.ts';
import type { Task } from './timing.ts';
import { claudeResponse, mergeClaudeResponses, readClaudeUsageRecords } from './claude-usage-records.ts';
import { tokenWindow } from './token-report.ts';
import { CLAUDE_USAGE_URL, claudeKeychainService, fetchClaudeQuota, normalizeClaudeQuota } from './claude-quota.ts';
import { buildClaudeRange } from './claude-range.ts';

const at = Date.parse('2026-10-02T02:00:00Z'), project = '/claude-fixture/project_one';
const scripts = fileURLToPath(new URL('.', import.meta.url));
const iso = (offset: number) => new Date(at + offset).toISOString();
const base = (offset: number, entrypoint = 'cli') => ({ timestamp: iso(offset), cwd: project, sessionId: 's', entrypoint, isSidechain: false });
const prompt = (offset: number, text: string, extra: object = {}) => ({ ...base(offset), type: 'user', uuid: `u${offset}`,
  promptId: `p${offset}`, message: { role: 'user', content: text }, ...extra });
const usage = { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 40,
  output_tokens_details: { thinking_tokens: 30 }, speed: 'standard' };
const assistant = (offset: number, id: string, block: object, stop: string, extra: object = {}) => ({ ...base(offset),
  type: 'assistant', uuid: `a${offset}`, effort: 'high', perTurnEffort: 'high',
  message: { id, model: 'claude-opus-5-5', role: 'assistant', stop_reason: stop, usage, content: [block] }, ...extra });
const thinking = (offset: number, id: string, ms?: number) => assistant(offset, id,
  { type: 'thinking', thinking: 'private-thinking-marker' }, 'tool_use', ms === undefined ? {} : { thinkingDurationMs: ms });
const toolUse = (offset: number, id: string, call: string, name = 'Edit', input: object = { file_path: `${project}/web/src/Sheet.tsx`, new_string: 'private-diff-marker' }) =>
  assistant(offset, id, { type: 'tool_use', id: call, name, input }, 'tool_use');
const toolResult = (offset: number, call: string) => ({ ...base(offset), type: 'user', uuid: `r${offset}`,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: 'private-output-marker' }] } });
const answer = (offset: number, id: string, text = 'Fixed the sheet. private-final-marker') =>
  assistant(offset, id, { type: 'text', text }, 'end_turn');
const system = (offset: number, subtype: string) => ({ ...base(offset), type: 'system', subtype, uuid: `s${offset}`, durationMs: offset });

/** One engineering request: 2s prompt, 5s thinking, 4s Edit wait, final answer at 20s. */
const request = (start = 0, text = '修复 sheet 弹窗. secret-user@example.com') => [
  prompt(start, text),
  thinking(start + 8_000, `m${start}a`, 5_000),
  toolUse(start + 9_000, `m${start}a`, `call${start}`),
  toolResult(start + 13_000, `call${start}`),
  answer(start + 20_000, `m${start}b`),
];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'remaining-range-claude-'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'private-claude-account', organizationUuid: 'org' } }));
  return { home, close: () => rmSync(home, { recursive: true, force: true }) };
}

function transcript(home: string, rows: object[], name = 'session.jsonl', dir = projectSlug(project)) {
  const path = join(home, 'projects', dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

async function parse(rows: object[]) {
  const f = fixture(), diagnostics: Record<string, number> = { malformedLines: 0, unreadableFiles: 0, excludedHeadless: 0 };
  try { return { tasks: await parseClaudeTranscript(transcript(f.home, rows), at - 1_000, at + 3_600_000, diagnostics), diagnostics }; }
  finally { f.close(); }
}

const report = (tasks: Task[]) => buildSpeedReport(tasks, {}, { since: at - 1_000, until: at + 3_600_000,
  timezone: 'Asia/Singapore', project, type: 'all', fingerprint: 'fixture', index: 'fixture', details: false, agent: 'claude' });

test('measures a CLI request from prompt to final answer with recorded thinking and tool waits', async () => {
  const { tasks, diagnostics } = await parse([...request(), system(20_100, 'stop_hook_summary'), system(20_200, 'turn_duration')]);
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'complete');
  assert.equal(diagnostics.completedByTurnDuration, 1);
  const m = measure(tasks[0], 'Asia/Singapore');
  assert.equal(m.model, 'claude-opus-5-5'); assert.equal(m.effort, 'high');
  assert.equal(m.speedMode, 'standard'); assert.equal(m.speedBasis, 'response');
  assert.equal(m.totalMs, 20_000); assert.equal(m.reasonMs, 5_000); assert.equal(m.waitingMs, 4_000);
  assert.equal(m.reasoningTokens, 60, 'split records of one message count once');
  assert.deepEqual(m.tokenUsage, { input: 304, cachedInput: 200, output: 80 });
  assert.equal(m.frontend, true); assert.equal(m.repair, true);
  const r = report(tasks);
  assert.equal(r.completedCount, 1); assert.equal(r.pricing, null);
  assert.deepEqual(r.completion.engineering, { total: 1, complete: 1, reportedPending: 0, interrupted: 0, open: 0 });
});

test('Desktop requests close on the Stop hook or end_turn and reopen when the agent continues', async () => {
  const continued = [...request(), system(20_100, 'stop_hook_summary'), toolUse(21_000, 'm2', 'late'),
    toolResult(22_000, 'late'), answer(30_000, 'm3')].map(r => ({ ...r, entrypoint: 'claude-desktop' }));
  const { tasks, diagnostics } = await parse(continued);
  assert.equal(tasks[0].status, 'complete'); assert.equal(diagnostics.completedByEndTurn, 1);
  assert.equal(measure(tasks[0], 'Asia/Singapore').totalMs, 30_000);
  const hooked = await parse([...request(), system(20_100, 'stop_hook_summary')]);
  assert.equal(hooked.diagnostics.completedByStopHook, 1);
});

test('absorbs prompts queued mid-tool-loop, ends interrupted requests and starts a new request after completion', async () => {
  const rows = [prompt(0, '修复页面'), toolUse(1_000, 'm1', 'c1'), prompt(1_500, '顺便看一下按钮'), toolResult(2_000, 'c1'),
    prompt(2_500, '还有菜单'), toolUse(3_000, 'm2', 'c2'),
    prompt(4_000, '[Request interrupted by user for tool use]'), ...request(10_000), system(30_100, 'turn_duration')];
  const { tasks } = await parse(rows);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'interrupted'); assert.equal(tasks[1].status, 'complete');
  const r = report(tasks);
  assert.equal(r.exclusions.unfinished, 1);
  assert.equal(r.completion.engineering.interrupted, 1); assert.equal(r.completion.engineering.complete, 1);
});

test('turns without recorded thinking durations count in completion but never in timing averages', async () => {
  const rows = request().map(r => ('thinkingDurationMs' in r ? { ...r, thinkingDurationMs: undefined } : r));
  const { tasks } = await parse([...rows, system(20_200, 'turn_duration')]);
  const r = report(tasks);
  assert.equal(r.completedCount, 0); assert.equal(r.exclusions.missingReasoningTiming, 1);
  assert.equal(r.completion.completionTime.n, 1); assert.equal(r.completion.completionTime.meanTotalMs, 20_000);
});

test('session cwd owns the request after the shell changes directory; commit and system requests are excluded', async () => {
  const moved = [...request(), system(20_200, 'turn_duration')].map((r, i) => (i ? { ...r, cwd: `${project}/web` } : r));
  const rows = [...moved, prompt(40_000, '<command-name>/commit</command-name><command-args></command-args>', { cwd: `${project}/web` }),
    answer(41_000, 'm9'), system(41_100, 'turn_duration'),
    prompt(50_000, '<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } })];
  const { tasks } = await parse(rows);
  assert.ok(tasks.every(t => t.cwd === project));
  const r = report(tasks);
  assert.equal(r.completion.requests.total, 1); assert.equal(r.completedCount, 1);
});

test('extracts literal Bash write targets without reading heredoc code as redirects', () => {
  assert.deepEqual(bashWrittenPaths("cat > src/a.ts <<'EOF'\nconst f = (x) => x.y;\nif (a > b.length) {}\nEOF", '/r'), ['/r/src/a.ts']);
  assert.deepEqual(bashWrittenPaths("sed -i '' 's/a.b/c/' .claude/x.json && echo ok > /dev/null 2>&1", '/r'), ['/r/.claude/x.json']);
  assert.deepEqual(bashWrittenPaths("cd /w && python3 - <<'EOF'\nopen('n.md', 'w').write(s)\nEOF", '/r'), ['/w/n.md']);
  assert.deepEqual(bashWrittenPaths("grep -n foo src/a.ts | head", '/r'), []);
});

test('reads only interactive root transcripts and prints no private content or saved statistics', async () => {
  const f = fixture();
  try {
    transcript(f.home, [...request(), system(20_200, 'turn_duration')]);
    transcript(f.home, [...request()].map(r => ({ ...r, entrypoint: 'sdk-cli' })), 'headless.jsonl');
    transcript(f.home, [...request(), system(20_200, 'turn_duration')].map(r => ({ ...r, isSidechain: true })), 'sidechain.jsonl');
    transcript(f.home, request(), 'agent-x.jsonl', join(projectSlug(project), 'session', 'subagents'));
    transcript(f.home, [...request(), system(20_200, 'turn_duration')], 'other.jsonl', projectSlug('/elsewhere'));
    const records = await readClaudeRecords(f.home, at - 1_000, at + 3_600_000, project);
    assert.equal(records.tasks.length, 1); assert.equal(records.diagnostics.excludedHeadless, 1);
    assert.equal(records.diagnostics.excludedSubagents, 1);
    assert.equal(readClaudeAccountId(f.home), 'private-claude-account:org');
    const snapshot = () => readdirSync(f.home, { recursive: true }).map(p => `${p}:${statSync(join(f.home, String(p))).mtimeMs}`).sort();
    const before = snapshot();
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'speed.ts'), '--agent', 'claude',
      '--claude-home', f.home, '--project', project, '--since', iso(-1_000), '--until', iso(3_600_000), '--details'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout);
    assert.equal(out.completedCount, 1); assert.equal(out.methodology.agent, 'claude');
    for (const secret of ['private-claude-account', 'secret-user@example.com', 'private-thinking-marker', 'private-diff-marker',
      'private-output-marker', 'private-final-marker']) assert.ok(!child.stdout.includes(secret), secret);
    assert.deepEqual(snapshot(), before);
  } finally { f.close(); }
});

test('Claude consumption includes subagents/headless/cross-window responses once and excludes idle gaps', async () => {
  const f = fixture();
  try {
    transcript(f.home, [...request(), system(20_200, 'turn_duration'), ...request(600_000), system(620_200, 'turn_duration')]);
    transcript(f.home, request(), 'copied.jsonl', projectSlug('/other'));
    transcript(f.home, request(30_000), 'agent-x.jsonl', join(projectSlug(project), 'session', 'subagents'));
    transcript(f.home, request(60_000).map(r => ({ ...r, entrypoint: 'sdk-cli' })), 'headless.jsonl');
    const records = await readClaudeUsageRecords(f.home, at + 5000, at + 3_600_000);
    const r = tokenWindow(records, at + 5000, at + 3_600_000);
    assert.equal(r.validResponses, 8); assert.equal(r.totalTokens, 1536);
    assert.equal(r.cachedInputTokens, 800); assert.equal(r.cacheCreationInputTokens, 400);
    assert.equal(r.plainInputTokens, 16); assert.equal(r.outputTokens, 320);
    assert.equal(r.reasoningOutputTokens, 240); assert.equal(r.visibleOutputTokens, 80);
    assert.equal(records.diagnostics.subagentFiles, 1);
    assert.equal(records.diagnostics.duplicateMessageRecords, 7);
    assert.ok(r.activeHours * 3600 < 80);
    assert.ok(r.evidence.every(e => /\.jsonl:\d+$/.test(e)));
  } finally { f.close(); }
});

test('Claude split messages use final cumulative usage, preserve conflicts and keep missing reasoning unknown', () => {
  const d = { duplicateMessageRecords: 0, conflictingMessages: 0 };
  const message = (id: string, output: number | undefined, input = 2) => ({ id, model: 'claude-opus-5-5',
    usage: { input_tokens: input, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: output } });
  const response = (id: string, output: number | undefined, offset = 0, input = 2) =>
    claudeResponse(message(id, output, input), at + offset, 'root', 'turn', id);
  const merged = mergeClaudeResponses([response('partial', undefined), response('partial', 10, 10), response('partial', 40, 20),
    response('partial', 40, 30), response('conflict', 40), response('conflict', 40, 10, 3), response('conflict', 40, 20)], d);
  const r = tokenWindow({ turns: [], points: [], anchors: [], diagnostics: d, cacheResponses: merged }, at, at + 100);
  assert.equal(r.totalTokens, 192); assert.equal(r.validResponses, 1); assert.equal(r.invalidResponses, 1);
  assert.equal(r.reasoningOutputTokens, null); assert.equal(d.conflictingMessages, 1);
  assert.equal(merged.find(r => r.responseId === 'partial')!.at, at + 20);
  assert.equal(claudeResponse(message('bad', -1), at, 'r', 't', 'a').output, null);
});

test('Claude quota normalizes server model scopes and legacy windows without adding percentages or credits', () => {
  const r = normalizeClaudeQuota({ limits: [
    { kind: 'session', percent: 15, resets_at: iso(3600_000) },
    { kind: 'weekly_all', percent: 9, resets_at: iso(7 * 86400_000) },
    { kind: 'weekly_scoped', percent: 0, resets_at: iso(7 * 86400_000), scope: { model: { id: null, display_name: 'Fable' } } },
  ], extra_usage: { is_enabled: false, used_credits: null } }, at);
  assert.deepEqual(r.windows.map(w => [w.usedPercent, w.remainingPercent, w.windowMinutes]), [[15, 85, 300], [9, 91, 10080], [0, 100, 10080]]);
  assert.equal(r.windows[2].modelScope!.label, 'Fable'); assert.equal(r.windows[1].modelScope, null);
  assert.equal(r.separateCredits!.usedCredits, null);
  const legacy = normalizeClaudeQuota({ five_hour: { utilization: 20, resets_at: iso(3600_000) },
    seven_day_sonnet: { utilization: 30, resets_at: null } }, at);
  assert.equal(legacy.windows[1].modelScope!.label, 'Sonnet');
  const bad = normalizeClaudeQuota({ limits: [{ kind: 'session', percent: 101 },
    { kind: 'weekly_all', percent: 9, resets_at: 'invalid' }] }, at);
  assert.equal(bad.status, 'unavailable'); assert.equal(bad.invalidWindows, 2);
  assert.equal(claudeKeychainService('/Users/alice/.claude', '/Users/alice'), 'Claude Code-credentials');
  assert.equal(claudeKeychainService('/Users/alice/.claude-profiles/work', '/Users/alice'), 'Claude Code-credentials-8b6c98a1');
});

test('price counters keep the 1-hour cache-write subset and group requests above the long-context boundary', () => {
  const usage = (input: number, read: number, write: number, ttl?: Record<string, number>) => ({ id: `m${input}`, model: 'claude-opus-5-5',
    usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 10, ...(ttl ? { cache_creation: ttl } : {}) } });
  const split = claudeResponse(usage(5, 100, 40, { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 }), at, 't', 'a', 's');
  assert.equal(split.cacheCreation1hInput, 30);
  assert.equal(claudeResponse(usage(5, 100, 40), at, 't', 'a', 's').cacheCreation1hInput, null);
  assert.equal(claudeResponse(usage(5, 100, 0), at, 't', 'a', 's').cacheCreation1hInput, 0);
  assert.equal(claudeResponse(usage(5, 100, 40, { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 }), at, 't', 'a', 's').cacheCreation1hInput, null);
  const big = claudeResponse(usage(1000, 300_000, 0), at + 10, 't', 'b', 's');
  const r = tokenWindow({ turns: [], points: [], anchors: [], diagnostics: {}, cacheResponses: [split, big] }, at, at + 100);
  assert.equal(r.cacheCreation1hInputTokens, 30);
  assert.deepEqual(r.longContext, { thresholdInputTokens: 272_000, responses: 1, inputTokens: 301_000,
    cachedInputTokens: 300_000, cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, outputTokens: 10 });
});

test('Claude quota answers from the statusline reading: fresh without a request, stale only when the endpoint fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-statusline-'));
  const now = Date.now();
  const write = (ageMs: number, fiveResetMs: number) => writeFileSync(join(dir, 'rate-limits.json'), JSON.stringify({
    capturedAt: new Date(now - ageMs).toISOString(),
    rate_limits: { five_hour: { used_percentage: 67, resets_at: Math.floor(fiveResetMs / 1000) },
      seven_day: { used_percentage: 37, resets_at: Math.floor((now + 3 * 86400_000) / 1000) } } }));
  try {
    await assert.rejects(fetchClaudeQuota(dir, { ignoreEnvCredentials: true, now }));
    write(60_000, now + 3600_000);
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture', subscriptionType: 'max' } }));
    const fresh = await fetchClaudeQuota(dir, { ignoreEnvCredentials: true, now });
    assert.equal(fresh.source, 'claude-code-statusline'); assert.equal(fresh.planReportedByCredentials, 'max');
    assert.deepEqual(fresh.windows.map(w => [w.window, w.usedPercent, w.windowMinutes]), [['claude:five_hour', 67, 300], ['claude:seven_day', 37, 10080]]);
    assert.ok(!('endpointError' in fresh));
    rmSync(join(dir, '.credentials.json'));
    write(10 * 60_000, now - 60_000);
    const stale = await fetchClaudeQuota(dir, { ignoreEnvCredentials: true, now });
    assert.match(String((stale as { endpointError?: string }).endpointError), /OAuth/);
    assert.deepEqual(stale.windows.map(w => w.window), ['claude:seven_day']);
    assert.equal(stale.observedAt, new Date(now - 10 * 60_000).toISOString());
    write(2 * 3600_000, now - 60_000);
    await assert.rejects(fetchClaudeQuota(dir, { ignoreEnvCredentials: true, now }), /too old/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude quota failure preserves token data, and range CLI needs neither Codex RPC nor model calls', async () => {
  const f = fixture();
  try {
    transcript(f.home, request());
    const r = await buildClaudeRange(f.home, 'Asia/Singapore', async () => { throw new Error('Claude usage HTTP 429; do not poll.'); }, at + 3600_000);
    assert.equal(r.quota.status, 'unavailable'); assert.equal(r.tokens.samples.at(-1)!.totalTokens, 384);
    assert.equal(r.dashboard.remainingMinutes, null);
    const shift = Date.now() - at - 60_000;
    transcript(f.home, request().map(row => ({ ...row, timestamp: new Date(Date.parse(row.timestamp) + shift).toISOString() })));
    const snapshot = () => readdirSync(f.home, { recursive: true }).map(p => `${p}:${statSync(join(f.home, String(p))).mtimeMs}`).sort();
    const before = snapshot();
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'range.ts'), '--agent', 'claude', '--claude-home', f.home],
      { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout); assert.equal(out.agent, 'claude');
    assert.equal(out.tokens.samples.at(-1).totalTokens, 384); assert.equal(out.quota.status, 'unavailable');
    assert.ok(!child.stdout.includes('private-claude-account')); assert.ok(!child.stdout.includes('private-thinking-marker'));
    assert.deepEqual(snapshot(), before);
    const both = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'range.ts'),
      '--agent', 'both', '--home', join(f.home, 'missing-codex'), '--claude-home', f.home],
    { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } });
    assert.equal(both.status, 0, both.stderr);
    const pair = JSON.parse(both.stdout);
    assert.equal(pair.agents.codex.status, 'unavailable'); assert.equal(pair.agents.claude.tokens.samples.at(-1).totalTokens, 384);
  } finally { f.close(); }
});

test('Claude windows count cumulative cycle tokens from their derived reset start, across local midnight, scoped by model', async () => {
  const f = fixture();
  try {
    // 2026-10-02T15:30Z is 23:30 in Singapore; the session window began there and the capture is 01:30 the next day.
    const early = Date.parse('2026-10-02T15:30:00Z'), capture = early + 2 * 3600_000, shift = early - at;
    transcript(f.home, request().map(row => ({ ...row, timestamp: new Date(Date.parse(row.timestamp) + shift).toISOString() })));
    transcript(f.home, request(-3600_000).map(row => ({ ...row, timestamp: new Date(Date.parse(row.timestamp) + shift).toISOString() })), 'stale.jsonl');
    const quota = async () => normalizeClaudeQuota({ limits: [
      { kind: 'session', percent: 8, resets_at: new Date(early - 60_000 + 5 * 3600_000).toISOString() },
      { kind: 'weekly_all', percent: 40, resets_at: new Date(capture + 3 * 86400_000).toISOString() },
      { kind: 'weekly_scoped', percent: 0, resets_at: new Date(capture + 3 * 86400_000).toISOString(),
        scope: { model: { id: null, display_name: 'Fable' } } },
    ] }, capture);
    const r: any = await buildClaudeRange(f.home, 'Asia/Singapore', quota as any, capture);
    const [session, weekly, fable] = r.quota.windows;
    assert.equal(session.cycleTokens.start, new Date(early - 60_000).toISOString());
    assert.equal(session.cycleTokens.totalTokens, 384); assert.equal(session.cycleTokens.quotaPercentagePoints, 8);
    assert.equal(session.cycleTokens.tokensPerQuotaPercentagePoint, 48);
    assert.equal(session.cycleTokens.projectedTokensPerFullWindow, 4800);
    // The weekly cycle began four days before capture, so it also holds the transcript before the session window.
    assert.equal(weekly.cycleTokens.start, new Date(capture - 4 * 86400_000).toISOString());
    assert.equal(weekly.cycleTokens.totalTokens, 768); assert.equal(weekly.cycleTokens.tokensPerQuotaPercentagePoint, 19.2);
    assert.equal(fable.cycleTokens.totalTokens, null); assert.equal(fable.cycleTokens.tokensPerQuotaPercentagePoint, null);
    assert.equal(r.tokens.samples.at(-1).totalTokens, null);
    assert.deepEqual(r.tokens.samples.map((s: any) => s.id), ['last_hour', 'last_three_hours', 'last_five_hours', 'today']);
  } finally { f.close(); }
});

test('Claude quota sends auth only to the fixed endpoint and never exposes error bodies or retries rate limits', async () => {
  const originalFetch = globalThis.fetch;
  const keys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
  const before = keys.map(k => process.env[k]);
  keys.forEach(k => delete process.env[k]); process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-token';
  let requests = 0;
  try {
    globalThis.fetch = async (input, options) => {
      requests++;
      assert.equal(input, CLAUDE_USAGE_URL); assert.equal(options!.redirect, 'error');
      assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer fixture-token');
      return new Response('fixture-token private-error-body', { status: 429 });
    };
    await assert.rejects(fetchClaudeQuota('/fixture'), { message: 'Claude usage HTTP 429; do not poll or retry immediately.' });
    assert.equal(requests, 1);
    process.env.ANTHROPIC_API_KEY = 'fixture-api-key';
    await assert.rejects(fetchClaudeQuota('/fixture'), /unavailable for API\/cloud authentication/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; });
  }
});
