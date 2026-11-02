#!/usr/local/bin/node
import { mkdtemp, copyFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const source = process.env.CODEX_HOME;
if (!source) throw new Error('CODEX_HOME is required.');
const runtime = await mkdtemp(join(tmpdir(), 'token-codex-'));
try {
  await copyFile(join(source, 'auth.json'), join(runtime, 'auth.json'));
  await chmod(join(runtime, 'auth.json'), 0o600);
  const child = spawn(process.execPath,
    ['/usr/local/lib/node_modules/@openai/codex/bin/codex.js', ...process.argv.slice(2)],
    { env: { ...process.env, CODEX_HOME: runtime }, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  await rm(runtime, { recursive: true, force: true });
}
