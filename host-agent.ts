/** Remote host agent: streams one sanitized snapshot JSON line every 2 s to the Token Arcade server over SSH and exits when SSH closes. */
import { hostname } from 'node:os';
import { startHostMonitor } from './host-telemetry.ts';
import { startWindowsMonitor } from './windows-telemetry.ts';
import type { RemoteSnapshot } from './web/remote-hosts.ts';

// `--once` prints the first complete snapshot and exits; the installer uses it as the acceptance probe.
const once = process.argv.includes('--once');
const name = hostname().slice(0, 64);
let stop = () => {};
const quit = () => { stop(); process.exit(0); };
const complete = (s: RemoteSnapshot) => s.cpu.usedPercent !== null && s.threads.total !== null;

function emit(snapshot: RemoteSnapshot) {
  if (once && !complete(snapshot)) return;
  process.stdout.write(`${JSON.stringify({ ...snapshot, hostname: name, platform: process.platform })}\n`);
  if (once) quit();
}

stop = process.platform === 'win32' ? startWindowsMonitor(emit) : startHostMonitor(emit, 2000, { workloads: false });
process.stdout.on('error', quit);
if (once) setTimeout(() => { process.stderr.write('No complete snapshot within 15 s\n'); stop(); process.exit(1); }, 15_000);
else process.stdin.on('end', quit).on('close', quit).resume();
