/** Charter: persisted tails reproduce measurements without replaying old text, and reject changed ownership or files. Collected by npm test. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskWatch } from './task-watch.ts';
import { pollLive, pollStalled } from './speed-policy.ts';

async function fixture(run: (f: { root: string; path: string; checkpoint: string; profiles: any[] }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'task-watch-'));
  const path = join(root, 'rollout.jsonl');
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (rollout_path TEXT, updated_at INTEGER, creator_account_id TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(path, Math.floor(Date.now() / 1000), 'owner');
  db.close();
  try { await run({ root, path, checkpoint: join(root, 'private/checkpoint.json'), profiles: [{ agent: 'codex', alias: 'co1', home: root }] }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const metadata = { type: 'session_meta', payload: { id: 'conversation', creator_account_id: 'owner' } };
const context = { type: 'turn_context', payload: { model: 'gpt-example' } };
const message = (id: string) => ({ type: 'event_msg', payload: { type: 'item_completed',
  started_at_ms: Date.now() - 2000, completed_at_ms: Date.now(), item: { type: 'AgentMessage', id,
    content: [{ type: 'Text', text: 'private transcript text' }] } } });
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('restart restores measurements and parses only appended messages', async () => fixture(async f => {
  await writeFile(f.path, lines(metadata, context, message('one')));
  let counted = 0; const first: any[] = [], next: any[] = [];
  const watch = new TaskWatch(f.profiles, text => { counted++; return text.length; }, () => 'owner', s => first.push(s), f.checkpoint);
  await watch.discover(); await watch.poll(); await watch.close();
  assert.equal(counted, 1);
  const serialized = await readFile(f.checkpoint, 'utf8');
  assert.ok(!serialized.includes('private transcript text'));
  const resumed = new TaskWatch(f.profiles, text => { counted++; return text.length; }, () => 'owner', s => next.push(s), f.checkpoint);
  await resumed.discover(); await resumed.poll();
  assert.deepEqual(next, first); assert.equal(counted, 1);
  await appendFile(f.path, lines(message('two'))); await resumed.poll(); await resumed.close();
  assert.equal(counted, 2); assert.equal(next.length, 2); assert.equal(next[1].model, 'gpt-example');
}));

test('partial final line resumes once, without storing its private text', async () => fixture(async f => {
  const complete = JSON.stringify(message('partial'));
  await writeFile(f.path, lines(metadata, context) + complete.slice(0, 90));
  const first = new TaskWatch(f.profiles, text => text.length, () => 'owner', () => {}, f.checkpoint);
  await first.discover(); await first.poll(); await first.close();
  const samples: any[] = [];
  await appendFile(f.path, complete.slice(90) + '\n');
  const second = new TaskWatch(f.profiles, text => text.length, () => 'owner', s => samples.push(s), f.checkpoint);
  await second.discover(); await second.poll(); await second.close();
  assert.equal(samples.length, 1); assert.equal(samples[0].sampleId, 'text:partial');
}));

test('replacement and account switch cannot reuse stale checkpoints', async () => fixture(async f => {
  await writeFile(f.path, lines(metadata, context, message('old')));
  const first = new TaskWatch(f.profiles, text => text.length, () => 'owner', () => {}, f.checkpoint);
  await first.discover(); await first.poll(); await first.close();
  await rename(f.path, f.path + '.old'); await writeFile(f.path, lines(metadata, context, message('new')));
  const samples: any[] = [];
  const second = new TaskWatch(f.profiles, text => text.length, () => 'owner', s => samples.push(s), f.checkpoint);
  await second.discover(); await second.poll(); await second.close();
  assert.deepEqual(samples.map(s => s.sampleId), ['text:new']);
  const wrong: any[] = [];
  const switched = new TaskWatch(f.profiles, text => text.length, () => 'other-owner', s => wrong.push(s), f.checkpoint);
  await switched.discover(); await switched.poll(); await switched.close();
  assert.equal(wrong.length, 0);
}));

test('flush reuses clean tail stamps while updating dirty tails', async () => fixture(async f => {
  const other = join(f.root, 'second.jsonl');
  const db = new DatabaseSync(join(f.root, 'state_5.sqlite'));
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(other, Math.floor(Date.now() / 1000), 'owner');
  db.close();
  await writeFile(f.path, lines(metadata, context, message('one')));
  await writeFile(other, lines(metadata, context, message('two')));
  const first = new TaskWatch(f.profiles, text => text.length, () => 'owner', () => {}, f.checkpoint);
  await first.discover(); await first.poll(); await first.close();
  const resumed = new TaskWatch(f.profiles, text => text.length, () => 'owner', () => {}, f.checkpoint);
  await resumed.discover(); await resumed.poll();
  const cleanTail = (resumed as any).tails.get(f.path);
  const originalStamp = cleanTail.stamp;
  assert.ok(originalStamp);
  await appendFile(other, lines(message('three')));
  await resumed.poll(); await resumed.flush();
  assert.equal(cleanTail.stamp, originalStamp);
  await resumed.close();
}));

test('Claude profile restores unchanged transcripts when another transcript is replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-watch-claude-'));
  const projects = join(root, 'projects/workspace');
  await mkdir(projects, { recursive: true });
  const keep = join(projects, 'keep.jsonl'), replaced = join(projects, 'replaced.jsonl');
  const checkpoint = join(root, 'checkpoint.json');
  const profiles = [{ agent: 'claude', alias: 'cc1', home: root }];
  const block = (id: string, tokens: number) => ({ type: 'assistant', uuid: id, sessionId: id,
    timestamp: new Date().toISOString(), thinkingDurationMs: 1000,
    message: { id, model: 'claude-opus-5-5', content: [{ type: 'thinking' }], stop_reason: 'end_turn',
      usage: { output_tokens: tokens, speed: 'standard' } } });
  try {
    await writeFile(keep, lines(block('keep-1', 100)));
    await writeFile(replaced, lines(block('old-1', 200)));
    const first = new TaskWatch(profiles, text => text.length, () => '', () => {}, checkpoint);
    await first.discover(); await first.poll(); await first.close();
    await rename(replaced, replaced + '.bak');
    await writeFile(replaced, lines(block('new-1', 300)));
    const restored: string[] = [], all: string[] = [];
    const second = new TaskWatch(profiles, text => text.length, () => '', s => all.push(s.sampleId), checkpoint);
    await second.restore();
    restored.push(...all);
    await second.discover(); await second.poll(); await second.close();
    assert.deepEqual(restored, ['response:keep-1']);
    assert.deepEqual(all, ['response:keep-1', 'response:new-1']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the poll loop stamps its progress so a silent stall is distinguishable from an idle account', async () => fixture(async f => {
  await writeFile(f.path, lines(metadata, context, message('one')));
  const watch = new TaskWatch(f.profiles, text => text.length, () => 'owner', () => {}, f.checkpoint);
  watch.progressAt = 0;
  await watch.discover(); await watch.poll();
  assert.ok(Date.now() - watch.progressAt < 5000); assert.equal(watch.stage, 'idle');
  watch.progressAt = 0;
  await watch.poll(); await watch.close();
  assert.ok(Date.now() - watch.progressAt < 5000, 'an idle poll still counts as progress');
  assert.ok(pollLive(29_999) && !pollLive(30_000) && !pollStalled(119_999) && pollStalled(120_000));
}));
