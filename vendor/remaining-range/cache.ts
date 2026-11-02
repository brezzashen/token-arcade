/** Read-only cache CLI using the owned rollout index and local account identity, without quota RPC or model calls. Prints today's per-conversation token hit rates; --hours and --thread narrow the requested report. */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readAccountId } from './quota.ts';
import { dayStart, readRecords } from './records.ts';
import { buildCacheReport, cacheWindow } from './cache-report.ts';

try {
  const { values } = parseArgs({ options: {
    home: { type: 'string', default: process.env.CODEX_HOME ?? `${homedir()}/.codex` },
    timezone: { type: 'string', default: 'Asia/Singapore' },
    hours: { type: 'string' }, thread: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('Usage: cache.ts [--hours N] [--thread ID] [--home PATH] [--timezone ZONE]\nDefaults to today; --hours selects a rolling interval. Prints metadata only; no RPC or persistence.\n');
  } else {
    const home = resolve(values.home!), timezone = values.timezone!, end = Date.now();
    const today = dayStart(end, timezone), hours = values.hours === undefined ? null : Number(values.hours);
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0)) throw new Error('hours must be greater than 0.');
    const start = hours === null ? today : end - hours * 3600_000;
    if (!Number.isFinite(start) || !Number.isFinite(new Date(start).getTime())) throw new Error('Invalid hours interval.');
    const accountId = readAccountId(home);
    const records = await readRecords(home, accountId, Math.min(start, today), end);
    if (readAccountId(home) !== accountId) throw new Error('Account changed during cache read; rerun.');
    const report = { title: 'Codex Cache Hit Rate', capturedAt: new Date(end).toISOString(), timezone,
      accountFingerprint: createHash('sha256').update(accountId).digest('hex').slice(0, 12),
      ...buildCacheReport(records, today, end, values.thread ?? process.env.CODEX_THREAD_ID),
      selected: { threadId: values.thread ?? null, ...cacheWindow(records, start, end, values.thread) } };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'unavailable', error: error instanceof Error ? error.message : 'Unexpected failure' })}\n`);
  process.exitCode = 1;
}
