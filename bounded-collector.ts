/** Bounds a collector's lifetime even when filesystem I/O prevents graceful exit. */
import { spawn, type ChildProcess } from 'node:child_process';

export function stopCollector(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error: any) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function collectOutput(command: string, args: string[], options: {
  env?: NodeJS.ProcessEnv; timeoutMs?: number; stopMs?: number;
  onStart?: (child: ChildProcess) => void; onDone?: (child: ChildProcess) => void;
} = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let overflow = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      env: options.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 24 * 1024 * 1024) chunks.push(chunk);
      else { overflow = true; stopCollector(child, 'SIGKILL'); }
    });
    child.stderr!.resume();
    child.once('close', code => {
      if (timedOut) return;
      clearTimeout(deadline);
      options.onDone?.(child);
      if (code !== 0 || overflow) reject(new Error('Quota collection failed.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.once('error', () => {
      clearTimeout(deadline);
      options.onDone?.(child);
      reject(new Error('Quota collection failed.'));
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      stopCollector(child, 'SIGTERM');
      setTimeout(() => {
        stopCollector(child, 'SIGKILL');
        options.onDone?.(child);
        reject(new Error('Quota collection timed out.'));
      }, options.stopMs ?? 1000);
    }, options.timeoutMs ?? 50_000);
    options.onStart?.(child);
  });
}
