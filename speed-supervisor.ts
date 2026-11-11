/** Restarts a passive collector when it exits or stops publishing complete snapshots. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export function superviseSpeed(command: string, args: string[], onReading: (reading: any) => void,
  onUnavailable: () => void, options: { startupMs?: number; maxStartupMs?: number; staleMs?: number; busyMs?: number; checkMs?: number;
    restartMs?: number; stopMs?: number; log?: (message: string) => void } = {}) {
  const startupMs = options.startupMs ?? 120_000, staleMs = options.staleMs ?? 60_000, busyMs = options.busyMs ?? 300_000;
  const log = options.log ?? (() => {});
  let stopped = false, worker: ChildProcess | null = null;
  let restart: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    if (stopped) return;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    worker = child;
    const startedAt = Date.now(), startupDeadline = startedAt + (options.maxStartupMs ?? 600_000);
    let deadline = startedAt + startupMs, terminating = false, published = false, snapshotAt = 0;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const lines = createInterface({ input: child.stdout! });
    // Provider and transcript errors can contain private data; log only supervisor events.
    child.stderr!.resume();
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      onUnavailable();
      child.kill('SIGTERM');
      forceStop = setTimeout(() => child.kill('SIGKILL'), options.stopMs ?? 5000);
    };
    lines.on('line', line => {
      if (terminating || stopped) return;
      try {
        const reading = JSON.parse(line), at = Date.parse(reading.observedAt);
        if (!Number.isFinite(at) || Math.abs(Date.now() - at) > staleMs) return;
        // Progress may extend initial backfill; after it, progress proves a live event loop whose polls a saturated host
        // slows, so it extends staleness only up to busyMs past the last complete snapshot.
        if (reading.type === 'stalled') {
          const stage = typeof reading.stage === 'string' && /^[a-z:\/-]{1,60}$/.test(reading.stage) ? reading.stage : 'unknown';
          log(`Speed collector poll loop stalled at ${stage}; restarting.`);
          terminate();
          return;
        }
        if (reading.type === 'progress') {
          deadline = published ? Math.min(snapshotAt + busyMs, Date.now() + staleMs)
            : Math.min(startupDeadline, Date.now() + Math.max(startupMs, staleMs));
          return;
        }
        if (!Array.isArray(reading.samples)) return;
        snapshotAt = Date.now();
        deadline = snapshotAt + staleMs;
        published = true;
        onReading(reading);
      } catch { /* Invalid records do not count as a heartbeat. */ }
    });
    const check = setInterval(() => {
      if (Date.now() > deadline && !terminating) {
        log('Speed collector heartbeat timed out; restarting.');
        terminate();
      }
    }, options.checkMs ?? 5000);
    child.once('error', () => { onUnavailable(); });
    child.once('close', () => {
      clearInterval(check);
      clearTimeout(forceStop);
      lines.close();
      if (worker === child) worker = null;
      onUnavailable();
      if (!stopped) {
        log('Speed collector stopped; restart scheduled.');
        restart = setTimeout(start, options.restartMs ?? 1000);
      }
    });
  };
  start();
  return () => {
    stopped = true;
    clearTimeout(restart);
    worker?.kill('SIGTERM');
  };
}
