import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ContentSpeed } from './content-speed.ts';
import { TaskOutput } from './task-output.ts';
import { outputSpeed } from './web/output-speed.ts';
import { acceptSample, freshTask, normalizeMode, sampleKey } from './speed-policy.ts';
import { TaskWatch } from './task-watch.ts';
import { DialogSpeed } from './dialog-speed.ts';
import { intervalSpeed } from './web/interval-speed.ts';
import { speedHistory } from './web/speed-history.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('stream rate excludes the first chunk and ignores empty deltas', () => {
  const meter = new ContentSpeed(text => text.length);
  meter.accept('abc', 1000);
  assert.equal(meter.reading().tokensPerSecond, null);
  meter.accept('', 1500);
  meter.accept('defghi', 3000);
  assert.equal(meter.reading().tokensPerSecond, 3);
  assert.equal(meter.reading().measuredTokens, 6);
  assert.equal(meter.reading().estimatedTokens, 9);
});
const message = (id = 'm1', start = 1000, end = 3000) => ({ type: 'event_msg', payload: { type: 'item_completed',
  started_at_ms: start, completed_at_ms: end, item: { type: 'AgentMessage', id,
    content: [{ type: 'Text', text: '123456' }, { type: 'Reasoning', text: 'not output' }] } } });
function owned(seen?: Set<string>) {
  const parser = new TaskOutput(text => text.length, 'co1', 'owner', seen);
  parser.accept({ type: 'session_meta', payload: { creator_account_id: 'owner' } }, 0);
  parser.accept({ type: 'turn_context', payload: { model: 'gpt-example' } }, 0);
  return parser;
}
test('task speed uses explicit timing, omits reasoning and deduplicates across replayed files', () => {
  const seen = new Set<string>(), first = owned(seen), replay = owned(seen);
  const sample = first.accept(message(), 0)!;
  assert.equal(sample.tokensPerSecond, 3);
  assert.equal(sample.model, 'gpt-example');
  assert.equal(sample.estimatedTokens, 6);
  assert.equal(first.accept(message(), 0), null);
  assert.equal(replay.accept(message(), 0), null);
  assert.equal(JSON.stringify(sample).includes('123456'), false);
});
test('unowned, old and zero-duration task messages cannot yield a speed', () => {
  const unowned = new TaskOutput(text => text.length, 'co1', 'owner');
  unowned.accept({ type: 'session_meta', payload: { creator_account_id: 'other' } }, 0);
  assert.equal(unowned.accept(message(), 0), null);
  assert.equal(owned().accept(message(), 4000), null);
  assert.equal(owned().accept(message('zero', 3000, 3000), 0)!.tokensPerSecond, null);
});
const claudeBlock = (uuid: string, at: number, type: string, thinkingDurationMs?: number, id = 'claude-response') => ({
  type: 'assistant', uuid, sessionId: 'claude-session', timestamp: new Date(at).toISOString(), thinkingDurationMs,
  message: { id, model: 'claude-example', content: [type === 'text' ? { type, text: '123456' } : { type }],
    stop_reason: 'tool_use' as string | null, usage: { output_tokens: 900, output_tokens_details: { thinking_tokens: 100 }, speed: 'standard' } } });
test('Claude speed spans the whole response from thinking start to its last block', () => {
  const parser = new TaskOutput(text => text.length, 'cc1'), average = new DialogSpeed();
  const thinking = parser.accept(claudeBlock('a', 3000, 'thinking', 2000), 0)!;
  assert.equal(thinking.kind, 'response');
  assert.equal(thinking.mode, 'standard');
  assert.equal(thinking.tokensPerSecond, 450);
  average.accept(thinking);
  parser.accept(claudeBlock('b', 3001, 'text'), 0);
  const last = parser.accept(claudeBlock('c', 10_000, 'tool_use'), 0)!;
  assert.equal(last.sampleId, thinking.sampleId);
  assert.equal(last.outputMs, 9000);
  assert.equal(last.tokensPerSecond, 100);
  assert.equal(parser.accept(claudeBlock('c', 10_000, 'tool_use'), 0), null);
  average.accept(last);
  const [reading] = average.readings(11_000, 3600_000);
  assert.equal(reading.responseSampleCount, 1);
  assert.equal(reading.responseTokensPerSecond, 100);
  assert.equal(reading.tokensPerSecond, 100);
  assert.equal(reading.excludedSamples, 0);
  const html = outputSpeed({ samples: [reading], nextFallbackAt: null, stale: false }, 11_000);
  assert.ok(html.includes('整段输出'));
  assert.ok(html.includes('100.0'));
  assert.ok(!html.includes('思考 / 正文'));
  assert.ok(html.includes('speed-primary is-single'));
});
test('Claude interim subagent blocks time the response but never yield a near-zero reading', () => {
  // Subagent transcripts write leading blocks with interim usage (a few tokens, no tier, stop_reason null) and
  // only the last block with the final usage; a response that never got its final block has no reading.
  const parser = new TaskOutput(text => text.length, 'cc4'), average = new DialogSpeed();
  const interim = (uuid: string, at: number, type: string, ms?: number, id?: string) => {
    const block = claudeBlock(uuid, at, type, ms, id);
    block.message.stop_reason = null;
    block.message.usage = { output_tokens: 3 } as any;
    return block;
  };
  assert.equal(parser.accept(interim('a', 3000, 'thinking', 2000), 0), null);
  const final = parser.accept(claudeBlock('b', 10_000, 'tool_use'), 0)!;
  assert.equal(final.mode, 'standard');
  assert.equal(final.outputMs, 9000);
  assert.equal(final.tokensPerSecond, 100);
  assert.equal(parser.accept(interim('c', 20_000, 'thinking', 1000, 'never-final'), 0), null);
  assert.equal(parser.accept(interim('d', 30_000, 'tool_use', undefined, 'never-final'), 0), null);
  average.accept(final);
  const rows = average.readings(31_000, 3600_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokensPerSecond, 100);
});
test('a sample re-emitted under another mode leaves the group of its earlier emission', () => {
  const average = new DialogSpeed(), at = new Date(10_000).toISOString(), started = new Date(1000).toISOString();
  const sample = { account: 'cc4', model: 'claude-example', sampleId: 'response:x', conversationId: 'c', kind: 'response',
    speedBasis: 'response', sampledAt: at, startedAt: started, outputMs: 9000 };
  average.accept({ ...sample, mode: 'unknown', measuredTokens: 3 });
  average.accept({ ...sample, mode: 'standard', measuredTokens: 900 });
  const rows = average.readings(11_000, 3600_000);
  assert.deepEqual(rows.map(row => [row.mode, row.tokensPerSecond]), [['standard', 100]]);
});
test('Claude responses without a timed leading thinking block stay unavailable', () => {
  const untimed = new TaskOutput(text => text.length, 'cc1').accept(claudeBlock('a', 3000, 'thinking'), 0)!;
  assert.equal(untimed.reason, 'missing_response_timing');
  assert.equal(untimed.outputMs, null);
  const textOnly = new TaskOutput(text => text.length, 'cc1').accept(claudeBlock('b', 3000, 'text'), 0)!;
  assert.equal(textOnly.tokensPerSecond, null);
  assert.equal(new TaskOutput(text => text.length, 'cc1').accept(claudeBlock('c', 3000, 'thinking', 2000), 2000)!.status, 'unavailable');
});
test('Fast settings survive tierless turn contexts and explicit Standard changes remain separate', () => {
  const parser = owned();
  assert.equal(parser.accept(message('unknown'), 0)!.mode, 'unknown');
  parser.accept({ type: 'event_msg', payload: { type: 'thread_settings_applied',
    thread_settings: { model: 'gpt-example', service_tier: 'priority' } } }, 0);
  parser.accept({ type: 'turn_context', payload: { model: 'gpt-example' } }, 0);
  const fast = parser.accept(message('fast'), 0)!;
  assert.equal(fast.mode, 'fast');
  assert.equal(fast.speedBasis, 'request');
  parser.accept({ type: 'turn_context', payload: { model: 'gpt-example', service_tier: 'default' } }, 0);
  const standard = parser.accept(message('standard'), 0)!;
  assert.equal(standard.mode, 'standard');
  assert.notEqual(sampleKey(fast), sampleKey(standard));
  assert.equal(normalizeMode('Recorded'), 'unknown');
  assert.equal(normalizeMode('Standard'), 'standard');
});
test('model cards show Fast configuration alongside a separately sampled Standard speed', () => {
  const fast = { ...owned().accept(message(), 0)!, mode: 'fast', speedBasis: 'request' };
  const standard = { ...fast, mode: 'standard', source: 'fallback', tokensPerSecond: 2 };
  const html = outputSpeed({ samples: [standard, fast], nextFallbackAt: null, stale: false }, 3000);
  assert.ok(html.includes('Fast 开启'));
  assert.ok(html.includes('请求配置'));
  assert.ok(html.includes('≈3.0 token/s'));
  assert.ok(html.includes('≈2.0 token/s'));
  assert.equal(html.split('<h3>gpt-example</h3>').length - 1, 1);
  const unknown = outputSpeed({ samples: [{ ...fast, mode: 'unknown' }], nextFallbackAt: null, stale: false }, 3000);
  assert.ok(unknown.includes('Fast 状态未知'));
});
test('speed cards follow each account in registry order and show the model it used most recently', () => {
  const base = owned().accept(message(), 0)!;
  const at = (account: string, model: string, sampledAt: number, tokensPerSecond: number) => ({ ...base, account, model,
    tokensPerSecond, status: 'sampled', sampledAt: new Date(sampledAt).toISOString() });
  const cards = (samples: any[], accounts?: string[], intervals?: any[]) => [...outputSpeed({ samples, intervals, nextFallbackAt: null, stale: false, accounts }, 5000)
    .matchAll(/<span>([^<]+) · (?:正在用|最近用过)<\/span>(?:<span[^>]*>[^<]*<\/span>)?<\/div>\s*<h3>([^<]+)<\/h3>/g)].map(match => `${match[1]}:${match[2]}`);
  const samples = [at('co1', 'gpt-6.1-sol', 4500, 1), at('cc1', 'claude-haiku', 4000, 9), at('cc1', 'claude-opus-5-5', 3000, 50),
    at('cc3', 'claude-opus-5-5', 1000, 9)];
  assert.deepEqual(cards(samples), ['cc1:claude-haiku', 'cc2:近 1 小时无对话', 'cc3:claude-opus-5-5', 'cc4:近 1 小时无对话', 'cc5:近 1 小时无对话', 'cc6:近 1 小时无对话', 'cc7:近 1 小时无对话', 'co1:gpt-6.1-sol',
    'co2:近 1 小时无对话', 'ag1:近 1 小时无对话', 'ag2:近 1 小时无对话']);
  assert.deepEqual(cards([...samples].reverse()), cards(samples));
  assert.deepEqual(cards(samples, ['cc3', 'co1', 'grok', 'ag1']), ['cc3:claude-opus-5-5', 'co1:gpt-6.1-sol', 'ag1:近 1 小时无对话', 'cc1:claude-haiku']);
  const historical = [{ id: 'last_three_hours', windowMs: 3 * 3600_000, start: new Date(0).toISOString(), end: new Date(5000).toISOString(),
    samples: [{ ...at('ag1', 'gemini-4-argon', 2000, 42), responseSampleCount: 1, responseTokensPerSecond: 42 }] }];
  assert.deepEqual(cards(samples, ['cc3', 'co1', 'grok', 'ag1'], historical), ['cc3:claude-opus-5-5', 'co1:gpt-6.1-sol', 'ag1:gemini-4-argon', 'cc1:claude-haiku']);
  const fallbackHtml = outputSpeed({ samples, intervals: historical, nextFallbackAt: null, stale: false }, 5000);
  assert.ok(fallbackHtml.includes('最近 3 小时均值'));
  // A card that falls back to an older window names its model as recently used, not as in use now.
  assert.ok(fallbackHtml.includes('ag1 · 最近用过') && fallbackHtml.includes('cc1 · 正在用'));
  assert.ok(fallbackHtml.includes('42.0'));
  const html = outputSpeed({ samples, nextFallbackAt: null, stale: false }, 5000);
  assert.ok(html.includes('<div class="speed-others"><span>近 1 小时其他模型</span><div><span>claude-opus-5-5</span><b>≈50.0 token/s</b></div></div>'));
});
test('speed cards carry the provider so values use its brand color', () => {
  const base = owned().accept(message(), 0)!;
  const html = outputSpeed({ samples: [
    { ...base, account: 'cc2', model: 'claude-opus-5-5', status: 'sampled' },
    { ...base, account: 'gm', model: 'gemini-4-argon', status: 'sampled' },
  ], nextFallbackAt: null, stale: false }, 3000);
  assert.ok(html.includes('class="speed-card " data-provider="Claude"><div class="speed-meta"><span>cc2 · 正在用</span>'));
  assert.ok(html.includes('class="speed-card " data-provider="Gemini"><div class="speed-meta"><span>gm · 正在用</span>'));
  assert.ok(html.includes('data-provider="Codex"><div class="speed-meta"><span>co2 · 正在用</span></div><h3>近 1 小时无对话</h3>'));
});
test('sampled and stale readings never claim live streaming and model text is escaped', () => {
  const sample = { ...owned().accept(message(), 0)!, model: '<script>', source: 'task', status: 'sampled' };
  const fresh = outputSpeed({ samples: [sample], nextFallbackAt: null, stale: false }, 3000);
  assert.ok(fresh.includes('≈3.0'));
  assert.ok(fresh.includes('&lt;script&gt;'));
  assert.equal(fresh.includes('is-streaming'), false);
  const stale = outputSpeed({ samples: [sample], nextFallbackAt: null, stale: true }, 3000);
  assert.equal(stale.includes('≈3.0'), false);
  assert.ok(stale.includes('采集连接中断'));
  const emptyStale = outputSpeed({ samples: [], accounts: ['cc1', 'co1'], nextFallbackAt: null, stale: true }, 3000);
  assert.equal((emptyStale.match(/<h3>采集连接中断<\/h3>/g) ?? []).length, 2);
  assert.doesNotMatch(emptyStale, /近 1 小时无对话|没有有效对话数据/);
});
test('fresh tasks suppress duplicate fallback; missing task timing preserves a usable fallback', () => {
  const now = 7_200_000;
  const task = { source: 'task', mode: 'standard', tokensPerSecond: 50, sampledAt: new Date(now - 1000).toISOString() };
  const fallback = { ...task, source: 'fallback' };
  assert.equal(freshTask(task, now), true);
  assert.equal(acceptSample(task, fallback, now), false);
  assert.equal(acceptSample({ ...task, mode: 'fast' }, fallback, now), true);
  assert.equal(acceptSample(fallback, task, now), true);
  assert.equal(acceptSample(fallback, { ...task, tokensPerSecond: null }, now), false);
  const old = { ...task, sampledAt: new Date(now - 3600_001).toISOString() };
  assert.equal(freshTask(old, now), false);
  assert.equal(acceptSample(task, old, now), false);
  assert.equal(acceptSample(old, fallback, now), true);
});
test('recent conversations use token/time weighting, expire old samples and isolate modes and accounts', () => {
  const average = new DialogSpeed(), now = 7200_000;
  const sample = (sampleId: string, conversationId: string, measuredTokens: number, outputMs: number | null) => ({
    ...owned().accept(message(sampleId), 0)!, sampleId, conversationId, measuredTokens, outputMs,
    sampledAt: new Date(now - 1000).toISOString(), startedAt: outputMs ? new Date(now - 1000 - outputMs).toISOString() : null,
    mode: 'fast', kind: 'text' });
  average.accept(sample('short', 'private-conversation-1', 120, 1000));
  average.accept(sample('long', 'private-conversation-2', 900, 30_000));
  average.accept(sample('short', 'private-conversation-1', 120, 1000));
  average.accept(sample('missing', 'private-conversation-3', 100, null));
  average.accept({ ...sample('old', 'private-old', 999, 1000), sampledAt: new Date(now - 3600_001).toISOString() });
  average.accept({ ...sample('standard', 'private-conversation-1', 10, 1000), mode: 'standard' });
  average.accept({ ...sample('other-account', 'private-other', 20, 1000), account: 'co2' });
  const rows = average.readings(now), row = rows.find(row => row.mode === 'fast' && row.account === 'co1')!;
  assert.equal(row.tokensPerSecond, 1020 / 31);
  assert.equal(row.sampleCount, 2);
  assert.equal(row.conversationCount, 2);
  assert.equal(row.excludedSamples, 1);
  assert.equal(rows.length, 3);
  assert.equal(JSON.stringify(rows).includes('private-'), false);
  assert.deepEqual(average.readings(now + 3600_000), []);
});
test('reasoning uses reported response tokens and unions timed reasoning intervals without counting tool output', () => {
  const parser = owned(), seen = new Set<string>();
  const reasoning = (id: string, start: number, end: number) => ({ type: 'event_msg', payload: { type: 'item_completed',
    turn_id: 'turn', started_at_ms: start, completed_at_ms: end, item: { id, type: 'Reasoning', raw_content: 'private-thinking' } } });
  parser.accept(reasoning('r1', 1000, 4000), 0);
  parser.accept(reasoning('r1', 1000, 4000), 0);
  parser.accept(reasoning('r2', 3000, 5000), 0);
  const usage = { type: 'token_usage_record', timestamp: new Date(6000).toISOString(), payload: {
    turn_id: 'turn', response_id: 'response-1', usage: { output_tokens: 450, reasoning_output_tokens: 200 } } };
  const reason = parser.accept(usage, 0)!;
  assert.equal(reason.measuredTokens, 200);
  assert.equal(reason.outputMs, 4000);
  assert.equal(reason.tokensPerSecond, 50);
  assert.equal(parser.accept(usage, 0), null);
  const average = new DialogSpeed();
  average.accept(reason); average.accept(parser.accept(message('body', 5000, 7000), 0)!);
  const row = average.readings(7000)[0];
  assert.equal(row.measuredTokens, 206);
  assert.equal(row.tokensPerSecond, 206 / 6);
  assert.equal(row.reasoningTokensPerSecond, 50);
  assert.equal(row.outputTokensPerSecond, 3);
  const html = outputSpeed({ samples: [row], nextFallbackAt: null, stale: false }, 7000);
  assert.ok(html.includes('<span>思考</span><strong>50.0</strong>'));
  assert.ok(html.includes('<span>输出</span><strong>3.0</strong>'));
  assert.equal(JSON.stringify(row).includes('private-thinking'), false);
  const a = owned(seen), b = owned(seen);
  a.accept(reasoning('shared', 1000, 5000), 0); b.accept(reasoning('shared', 1000, 5000), 0);
  assert.ok(a.accept(usage, 0)); assert.equal(b.accept(usage, 0), null);
});
test('rolling intervals retain history, weight tokens/time and exclude incomplete boundary segments', () => {
  const average = new DialogSpeed(), hour = 3600_000, now = 300 * hour;
  const add = (id: string, age: number, tokens: number, seconds: number, startAge?: number) => {
    const row = { ...owned().accept(message(id, now - age * hour - seconds * 1000, now - age * hour), 0)!,
      measuredTokens: tokens, mode: 'fast', conversationId: `private-${id}` };
    if (startAge) row.startedAt = new Date(now - startAge * hour).toISOString();
    average.accept(row); average.accept(row);
  };
  add('recent', 0.5, 100, 1); add('two', 2, 1000, 20); add('four', 4, 300, 10);
  add('day', 23, 200, 10); add('three-days', 70, 400, 10); add('seven-days', 160, 600, 10); add('expired', 169, 9999, 1);
  assert.equal(average.readings(now)[0].sampleCount, 1);
  const windows = average.intervals(now);
  assert.deepEqual(windows.map(window => window.samples[0].sampleCount), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(windows.map(window => window.samples[0].tokensPerSecond), [100, 1100 / 21, 1400 / 31, 1600 / 41, 2000 / 51, 2600 / 61]);
  assert.equal(new Set(windows.map(window => window.end)).size, 1);
  assert.equal(JSON.stringify(windows).includes('private-'), false);
  add('boundary', 0.9, 50, 1, 1.1);
  const after = average.intervals(now);
  assert.equal(after[0].samples[0].sampleCount, 1);
  assert.equal(after[0].samples[0].excludedSamples, 1);
  assert.equal(after[1].samples[0].sampleCount, 3);
});
test('interval rendering isolates the selected account and mode and hides stale rates', () => {
  const average = new DialogSpeed();
  average.accept({ ...owned().accept(message(), 0)!, model: '<model>', mode: 'fast' });
  average.accept({ ...owned().accept(message('other'), 0)!, account: 'co2', model: 'private-other-model' });
  const snapshot = { intervals: average.intervals(3000), samples: [], nextFallbackAt: null, stale: false };
  const html = intervalSpeed('co1', snapshot);
  assert.equal(html.includes('private-other-model'), false);
  assert.ok(html.includes('&lt;model&gt;'));
  assert.ok(html.includes('Fast'));
  assert.equal(html.split('≈3.0').length - 1, 12);
  assert.ok(html.includes('最近 24 小时'));
  assert.equal(intervalSpeed('co1', { ...snapshot, stale: true }).includes('≈3.0'), false);
});
test('task discovery backfills completed conversations older than the headline window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-interval-test-'));
  try {
    const path = join(dir, 'rollout.jsonl'), end = Date.now() - 6 * 24 * 3600_000;
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (rollout_path TEXT, updated_at INTEGER, creator_account_id TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(path, Math.floor(end / 1000), 'owner'); db.close();
    writeFileSync(path, [
      { type: 'session_meta', payload: { creator_account_id: 'owner' } },
      { type: 'turn_context', payload: { model: 'gpt-example' } }, message('historical', end - 1000, end),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const average = new DialogSpeed();
    const watcher = new TaskWatch([{ agent: 'codex', alias: 'co1', home: dir }], text => text.length,
      () => 'owner', sample => average.accept(sample));
    await watcher.discover(); await watcher.poll();
    assert.equal(average.readings().length, 0);
    assert.equal(average.intervals()[4].samples.length, 0);
    assert.equal(average.intervals()[5].samples[0].outputTokensPerSecond, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Ultrafast has an independent current comparison and historical account/window filtering', () => {
  const now = 200 * 3600_000, average = new DialogSpeed();
  const add = (id: string, account: string, mode: string, age: number, tokens: number) => average.accept({
    ...owned().accept(message(id, now - age - 1000, now - age), 0)!, account, mode,
    model: 'gpt-example', measuredTokens: tokens,
  });
  add('ultra', 'co1', 'ultrafast', 1000, 75);
  add('fast', 'co1', 'fast', 2000, 50);
  add('standard', 'co1', 'standard', 3000, 25);
  add('old-ultra', 'co1', 'ultrafast', 6 * 24 * 3600_000, 125);
  add('other-account', 'co2', 'standard', 2000, 999);
  const snapshot = { intervals: average.intervals(now), samples: average.readings(now), accounts: ['co1', 'co2'], nextFallbackAt: null, stale: false };
  const current = outputSpeed(snapshot, now);
  assert.match(current, /Ultrafast<i>当前<\/i><\/span><b>≈75.0 token\/s/);
  const week = speedHistory(snapshot, 'last_seven_days', 'co1');
  assert.match(week, /data-provider="Codex"><img src="\/logos\/openai\.svg"/);
  assert.match(week, /Ultrafast/);
  assert.match(week, /≈100.0/);
  assert.doesNotMatch(week, /≈999.0/);
  assert.match(week, /data-speed-window="last_seven_days" aria-pressed="true"/);
  const threeDays = speedHistory(snapshot, 'last_three_days', 'co1');
  assert.match(threeDays, /≈75.0/);
  assert.doesNotMatch(threeDays, /≈100.0/);
  assert.doesNotMatch(speedHistory({ ...snapshot, stale: true }, 'last_seven_days', 'co1'), /≈/);
  assert.match(speedHistory({ ...snapshot, intervals: [] }), /暂无有效对话测速记录/);
});

test('historical windows exclude segments crossing the 3-day and 7-day start', () => {
  const average = new DialogSpeed(), day = 24 * 3600_000, now = 10 * day;
  for (const [id, boundary] of [['three', 3 * day], ['seven', 7 * day]] as const) {
    average.accept({ ...owned().accept(message(id, now - boundary - 500, now - boundary + 500), 0)!, mode: 'ultrafast' });
  }
  const three = average.readings(now, 3 * day)[0];
  assert.equal(three.sampleCount, 0);
  assert.equal(three.excludedSamples, 1);
  const seven = average.readings(now, 7 * day)[0];
  assert.equal(seven.sampleCount, 1);
  assert.equal(seven.excludedSamples, 1);
});

test('historical speed sorting respects filters and puts missing rates last', () => {
  const sample = { source: 'task', status: 'measured', reason: null, mode: 'standard',
    sampledAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    estimatedTokens: 0, measuredTokens: 0, outputMs: null, firstTextMs: null };
  const rows = [
    { account: 'co1', model: 'gpt-missing', tokensPerSecond: null },
    { account: 'co1', model: 'gpt-fast', tokensPerSecond: 100 },
    { account: 'co1', model: 'gpt-slow', tokensPerSecond: 10 },
    { account: 'co1', model: 'gpt-zero', tokensPerSecond: 0 },
    { account: 'co2', model: 'gpt-other', tokensPerSecond: 999 },
  ].map(row => ({ ...sample, ...row }));
  const snapshot = { samples: [], nextFallbackAt: null, stale: false,
    intervals: [{ id: 'last_hour', windowMs: 3600_000, start: sample.sampledAt, end: sample.sampledAt, samples: rows }] };
  const models = (html: string) => [...html.matchAll(/<td class="history-model">([^<]+)<\/td>/g)].map(match => match[1]);
  const fastest = speedHistory(snapshot, 'last_hour', 'co1', 'all', 'fastest');
  assert.deepEqual(models(fastest), ['gpt-fast', 'gpt-slow', 'gpt-zero', 'gpt-missing']);
  assert.match(fastest, /data-speed-sort="fastest" aria-pressed="true"/);
  assert.deepEqual(models(speedHistory(snapshot, 'last_hour', 'co1', 'all', 'slowest')),
    ['gpt-zero', 'gpt-slow', 'gpt-fast', 'gpt-missing']);
  assert.deepEqual(models(speedHistory(snapshot, 'last_hour', 'all', 'gpt-slow', 'fastest')), ['gpt-slow']);
  assert.deepEqual(models(speedHistory(snapshot, 'last_hour', 'co1')),
    ['gpt-fast', 'gpt-missing', 'gpt-slow', 'gpt-zero']);
  assert.deepEqual(models(speedHistory({ ...snapshot, stale: true }, 'last_hour', 'co1', 'all', 'fastest')),
    models(speedHistory(snapshot, 'last_hour', 'co1')));
  assert.deepEqual(snapshot.intervals[0].samples, rows);
});
test('missing reasoning time and invalid usage are excluded without estimating hidden thinking text', () => {
  const parser = owned();
  const usage = { type: 'token_usage_record', timestamp: new Date(6000).toISOString(), payload: {
    turn_id: 'turn', response_id: 'missing-time', usage: { output_tokens: 450, reasoning_output_tokens: 200 } } };
  const row = parser.accept(usage, 0)!;
  assert.equal(row.outputMs, null);
  const average = new DialogSpeed(); average.accept(row);
  assert.equal(average.readings(6000)[0].tokensPerSecond, null);
  assert.equal(parser.accept({ ...usage, payload: { ...usage.payload, response_id: 'invalid',
    usage: { output_tokens: 100, reasoning_output_tokens: 200 } } }, 0), null);
  const html = outputSpeed({ samples: average.readings(6000), nextFallbackAt: null, stale: false, fallbackEnabled: false }, 6000);
  assert.ok(html.includes('自动测速已关闭'));
  assert.equal(html.includes('下次兜底'), false);
  assert.equal(html.includes('≈'), false);
});
test('incremental task reads preserve a UTF-8 character split between writes without duplicate samples', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-speed-test-'));
  try {
    const path = join(dir, 'rollout.jsonl'), now = Date.now();
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (rollout_path TEXT, updated_at INTEGER, creator_account_id TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(path, Math.floor(now / 1000), 'owner');
    db.close();
    const row = message('utf8', now - 1000, now);
    row.payload.item.content = [{ type: 'Text', text: '你好' }];
    const bytes = Buffer.from(JSON.stringify(row) + '\n'), split = bytes.indexOf(Buffer.from('你')) + 1;
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { creator_account_id: 'owner' } }) + '\n'
      + JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-example' } }) + '\n');
    appendFileSync(path, bytes.subarray(0, split));
    const counted: string[] = [], samples: any[] = [];
    const watcher = new TaskWatch([{ agent: 'codex', alias: 'co1', home: dir }], text => {
      counted.push(text); return text.length;
    }, () => 'owner', sample => samples.push(sample));
    await watcher.discover(); await watcher.poll();
    assert.equal(samples.length, 0);
    appendFileSync(path, bytes.subarray(split));
    await watcher.poll(); await watcher.poll();
    assert.deepEqual(counted, ['你好']);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].tokensPerSecond, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
