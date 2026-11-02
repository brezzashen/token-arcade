/** Publishes rolling conversation averages; provider probes are disabled unless explicitly enabled and never override usable conversation data. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';
import { TaskWatch } from './task-watch.ts';
import { acceptSample, freshTask, normalizeMode, sampleKey } from './speed-policy.ts';
import { DialogSpeed } from './dialog-speed.ts';
import { readAntigravitySpeed } from './antigravity-speed.ts';
import { createHash } from 'node:crypto';

const [script, aliases] = process.argv.slice(2);
const load = (name: string) => import(pathToFileURL(resolve(dirname(script), name + '.ts')).href);
const { selectAccounts } = await load('account-registry');
const { readAccountId } = await load('quota');
const encoder = new Tiktoken(ranks);
const samples = new Map<string, any>();
const dialogs = new DialogSpeed();
const fallbackEnabled = process.env.TOKEN_SPEED_FALLBACK === '1';
const hour = 3600_000;
const models = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'claude-opus-5-5'];
let child: ReturnType<typeof spawn> | null = null;
let running = false, polling = false;
let nextFallbackAt = Date.now() + 30_000;
const schedulePath = resolve(homedir(), '.local/share/token-dashboard/speed-schedule.json');
try {
  const saved = JSON.parse(await readFile(schedulePath, 'utf8'));
  nextFallbackAt = Math.max(nextFallbackAt, saved.nextFallbackAt ?? 0);
  for (const sample of fallbackEnabled ? saved.samples ?? [] : []) {
    if (sample.source === 'fallback' && sample.status === 'sampled' && Date.parse(sample.sampledAt) > Date.now() - hour) {
      sample.mode = normalizeMode(sample.mode);
      sample.speedBasis ??= 'request';
      samples.set(sampleKey(sample), sample);
    }
  }
}
catch { /* First installation has no scheduling receipt. */ }
async function saveSchedule() {
  await mkdir(dirname(schedulePath), { recursive: true });
  await writeFile(schedulePath + '.next', JSON.stringify({ nextFallbackAt,
    samples: [...samples.values()].filter(sample => sample.source === 'fallback' && sample.status === 'sampled') }), { mode: 0o600 });
  await rename(schedulePath + '.next', schedulePath);
}
function publish(sample: any) {
  if (sample.source === 'task') { dialogs.accept(sample); return; }
  sample.mode = normalizeMode(sample.mode);
  const key = sampleKey(sample), previous = samples.get(key);
  if (!acceptSample(previous, sample, Date.now())) return;
  samples.set(key, sample);
  emitState();
}
function emitState() {
  const now = Date.now(), intervals = dialogs.intervals(now), taskSamples = intervals[0].samples;
  process.stdout.write(JSON.stringify({ samples: [...taskSamples, ...[...samples.values()].filter(sample =>
    !taskSamples.some(task => sampleKey(task) === sampleKey(sample) && freshTask(task, Date.now())))],
    nextFallbackAt: fallbackEnabled ? nextFallbackAt : null, fallbackEnabled, windowMs: hour, intervals, accounts: aliases.split(','),
    fallbackIntervalMs: hour, observedAt: new Date(now).toISOString() }) + '\n');
}
const watcher = new TaskWatch(selectAccounts({ only: aliases.split(',').filter(alias => !alias.startsWith('gm') && !alias.startsWith('ag')) }), text => encoder.encode(text, [], []).length,
  readAccountId, publish, resolve(homedir(), '.local/share/token-dashboard/state',
    `speed-${createHash('sha256').update((process.env.TOKEN_SPEED_CHECKPOINT_SOURCE ?? script) + aliases).digest('hex').slice(0,16)}.json.gz`));
async function fallback() {
  if (running || !fallbackEnabled || Date.now() < nextFallbackAt) return;
  running = true; nextFallbackAt = Date.now() + hour;
  try {
    await saveSchedule();
  } catch { running = false; return; }
  const observedModels = dialogs.readings().filter(sample => sample.source === 'task'
    && Date.parse(sample.sampledAt) > Date.now() - hour).map(sample => sample.model)
    .filter(model => /^(gpt-|claude-)/.test(model));
  for (const model of [...new Set([...observedModels, ...models])]) {
    const previous = dialogs.readings().find(sample => sample.model === model && sample.mode === 'standard');
    if (freshTask(previous, Date.now())) continue;
    const account = model.startsWith('claude-') ? 'cc1' : 'co1';
    if (!aliases.split(',').includes(account)) continue;
    await new Promise<void>(resolveDone => {
      child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning',
        resolve(dirname(fileURLToPath(import.meta.url)), 'speed-probe.js'), script, model],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr!.resume();
      const reader = createInterface({ input: child.stdout! });
      reader.on('line', line => { try { publish({ ...JSON.parse(line), source: 'fallback' }); } catch { /* Aggregate protocol only. */ } });
      const watchdog = setTimeout(() => stopChild(), 95_000);
      const done = () => { clearTimeout(watchdog); reader.close(); stopChild(); child = null; resolveDone(); };
      child.once('close', done); child.once('error', done);
    });
    try { await saveSchedule(); } catch { /* The hourly receipt already prevents a repeat after restart. */ }
  }
  running = false;
}
function stopChild() { if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ } } }
const readGeminiSpeed = async () => {
  const selected = new Set(aliases.split(',').map(a => a === 'gm' ? 'ag1' : a === 'gm2' ? 'ag2' : a));
  if (!selected.has('ag1') && !selected.has('ag2')) return;
  for (const sample of await readAntigravitySpeed()) {
    if (selected.has(sample.account)) dialogs.accept(sample);
  }
};
const heartbeat = setInterval(() => process.stdout.write(JSON.stringify({ type: 'progress', observedAt: new Date().toISOString() }) + '\n'), 5000);
await watcher.discover(); await watcher.poll(); await readGeminiSpeed();
emitState();
let ticks = 0;
// Recomputing every speed window costs ~90% of this worker, so publish every fifth tick (10 s), inside /api/speed staleness (20 s).
const emitEveryTicks = 5;
const timer = setInterval(async () => {
  if (polling) return;
  polling = true;
  try { if (++ticks % 8 === 0) await watcher.discover(); await watcher.poll(); await readGeminiSpeed(); if (ticks % emitEveryTicks === 0) emitState(); void fallback(); }
  finally { polling = false; }
}, 2000);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  clearInterval(timer); clearInterval(heartbeat); stopChild();
  void watcher.close().finally(() => process.exit(0));
});
