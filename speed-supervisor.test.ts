import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { superviseSpeed } from './speed-supervisor.ts';

const snapshot = 'JSON.stringify({ samples: [], observedAt: new Date().toISOString() })';
const options = { startupMs: 500, staleMs: 150, checkMs: 20, restartMs: 20, stopMs: 30 };
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await delay(20);
  assert.ok(check(), 'Collector did not recover within three seconds');
}

test('collector restarts after exiting and stops permanently on disposal', async () => {
  let readings = 0, unavailable = 0;
  const stop = superviseSpeed(process.execPath, ['-e', `console.log(${snapshot})`],
    () => readings++, () => unavailable++, options);
  try { await waitFor(() => readings >= 2); assert.ok(unavailable >= 1); }
  finally { stop(); }
  const captured = readings;
  await delay(250);
  assert.equal(readings, captured);
});

test('live but silent collector restarts after missing its heartbeat', async () => {
  let readings = 0;
  const events: string[] = [];
  const stop = superviseSpeed(process.execPath, ['-e', `console.log(${snapshot}); setInterval(()=>{},1000)`],
    () => readings++, () => {}, { ...options, log: message => events.push(message) });
  try {
    await waitFor(() => readings >= 2);
    assert.ok(events.some(message => message.includes('heartbeat timed out')));
  } finally { stop(); }
});

test('invalid or old snapshots do not keep a stalled collector alive', async () => {
  let readings = 0;
  const events: string[] = [];
  const stop = superviseSpeed(process.execPath, ['-e',
    'setInterval(()=>console.log(JSON.stringify({samples:[],observedAt:"2000-01-01T00:00:00Z"})),20)'],
    () => readings++, () => {}, { ...options, log: message => events.push(message) });
  try {
    await waitFor(() => events.some(message => message.includes('heartbeat timed out')));
    assert.equal(readings, 0);
  } finally { stop(); }
});

test('collector with current heartbeats stays running', async () => {
  let readings = 0;
  const events: string[] = [];
  const stop = superviseSpeed(process.execPath, ['-e', `setInterval(()=>console.log(${snapshot}),30)`],
    () => readings++, () => {}, { ...options, log: message => events.push(message) });
  try { await delay(450); assert.ok(readings >= 5); assert.deepEqual(events, []); }
  finally { stop(); }
});

test('backfill progress keeps the worker alive without publishing incomplete measurements', async () => {
  let readings = 0;
  const events: string[] = [];
  const stop = superviseSpeed(process.execPath, ['-e',
    'setInterval(()=>console.log(JSON.stringify({type:"progress",observedAt:new Date().toISOString()})),30)'],
    () => readings++, () => {}, { ...options, log: message => events.push(message) });
  try { await delay(650); assert.equal(readings, 0); assert.deepEqual(events, []); }
  finally { stop(); }
});

test('progress keeps a slowed collector alive past staleness, within its busy bound', async () => {
  let readings = 0;
  const events: string[] = [];
  const stop = superviseSpeed(process.execPath, ['-e',
    `console.log(${snapshot}); setInterval(()=>console.log(JSON.stringify({type:"progress",observedAt:new Date().toISOString()})),30)`],
    () => readings++, () => {}, { ...options, busyMs: 2000, log: message => events.push(message) });
  try { await delay(450); assert.equal(readings, 1); assert.deepEqual(events, []); }
  finally { stop(); }
});

test('progress cannot conceal stalled results past the busy bound', async () => {
  let readings = 0;
  const events: string[] = [];
  const stop = superviseSpeed(process.execPath, ['-e',
    `console.log(${snapshot}); setInterval(()=>console.log(JSON.stringify({type:"progress",observedAt:new Date().toISOString()})),30)`],
    () => readings++, () => {}, { ...options, busyMs: 300, log: message => events.push(message) });
  try {
    await waitFor(() => readings >= 2);
    assert.ok(events.some(message => message.includes('heartbeat timed out')));
  } finally { stop(); }
});

test('initial backfill progress has a hard deadline', async () => {
  const events: string[] = [];
  const stop = superviseSpeed(process.execPath, ['-e',
    'setInterval(()=>console.log(JSON.stringify({type:"progress",observedAt:new Date().toISOString()})),30)'],
    () => assert.fail('Progress is not a complete snapshot'), () => {},
    { ...options, maxStartupMs: 220, log: message => events.push(message) });
  try { await waitFor(() => events.some(message => message.includes('heartbeat timed out'))); }
  finally { stop(); }
});
