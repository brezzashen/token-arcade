/** Regression coverage for collectors stalled across a moved filesystem. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectOutput } from './bounded-collector.ts';

test('a completed collector preserves its output', async () => {
  assert.equal(await collectOutput(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok');
});

test('a collector that cannot handle signals does not block other account results', async () => {
  let pid: number | undefined;
  const started = Date.now();
  const results = await Promise.allSettled([
    collectOutput(process.execPath, ['-e', "process.on('SIGTERM', () => {}); for (;;) {}"], {
      timeoutMs: 250, stopMs: 50, onStart: child => { pid = child.pid; },
    }),
    collectOutput(process.execPath, ['-e', 'process.stdout.write("healthy")']),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.deepEqual(results[1], { status: 'fulfilled', value: 'healthy' });
  assert.ok(Date.now() - started < 3000);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
});

test('a failed collector rejects without exposing provider output', async () => {
  await assert.rejects(collectOutput(process.execPath, ['-e', 'console.error("private");process.exit(1)']),
    error => error instanceof Error && error.message === 'Quota collection failed.');
});
