/** Charter: persisted tails reproduce measurements without replaying old text, and reject changed ownership or files. Collected by npm test. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskWatch } from './task-watch.ts';

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
