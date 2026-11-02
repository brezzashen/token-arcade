/** Speed Test CLI: reads local Codex logs (default) or Claude Code transcripts (--agent claude), prints timing by speed tier and request completion counts; Codex also gets calibrated weekly-quota estimates and strict observations/credit estimates, whose account calibration includes all local turns and subagents. No quota RPC, paid benchmark calls or report/cache writes. */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readAccountId } from './quota.ts';
import { dayStart, readRecords } from './records.ts';
import { prepareWeeklyQuota } from './weekly-quota.ts';
import { calibrateQuota } from './quota-estimate.ts';
import { readSpeedRecords } from './speed-records.ts';
import { buildSpeedReport } from './speed-report.ts';
import { readClaudeAccountId, readClaudeRecords } from './claude-records.ts';
import type { TaskType } from './speed-report.ts';

function positive(value: string, option: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${option} must be greater than zero.`);
  return n;
}

export function queryWindow(values: { since?: string; until?: string; days?: string; hours?: string; timezone?: string }, now: number) {
  const timezone = values.timezone ?? 'Asia/Singapore';
  if ([values.since, values.days, values.hours].filter(v => v !== undefined).length > 1) {
    throw new Error('Use only one of --days, --hours or --since.');
  }
  const until = values.until ? Date.parse(values.until) : now;
  if (!Number.isFinite(until) || until > now) throw new Error('--until must be a valid timestamp no later than now.');
  dayStart(until, timezone);
  let since: number;
  if (values.since) since = Date.parse(values.since);
  else if (values.hours) since = until - positive(values.hours, '--hours') * 3_600_000;
  else {
    const days = positive(values.days ?? '2', '--days');
    if (!Number.isInteger(days)) throw new Error('--days must be a positive integer.');
    since = dayStart(until, timezone);
    for (let i = 1; i < days; i++) since = dayStart(since - 1, timezone);
  }
  if (!Number.isFinite(since) || since >= until) throw new Error('Query start must be before the end.');
  return { since, until, timezone };
}

export async function main(args: string[]) {
  const began = performance.now();
  const { values } = parseArgs({ args, options: {
    home: { type: 'string', default: process.env.CODEX_HOME ?? `${homedir()}/.codex` },
    agent: { type: 'string', default: 'codex' },
    'claude-home': { type: 'string', default: process.env.CLAUDE_CONFIG_DIR ?? `${homedir()}/.claude` },
    timezone: { type: 'string', default: 'Asia/Singapore' }, days: { type: 'string' }, hours: { type: 'string' },
    since: { type: 'string' }, until: { type: 'string' }, project: { type: 'string' },
    'all-projects': { type: 'boolean', default: false }, type: { type: 'string', default: 'all' },
    details: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    process.stdout.write('Speed Test: --days 2 (local calendar days) | --hours 24 | --since ISO [--until ISO]\n'
      + '--project PATH (default cwd) | --all-projects; --type all|frontend|frontend-repair|deployment\n'
      + '--agent codex|claude; --home CODEX_HOME | --claude-home CLAUDE_CONFIG_DIR; --timezone Asia/Singapore --details\n'
      + 'JSON to stdout only, no report/cache writes or quota RPC.\n');
    return;
  }
  if (values.project && values['all-projects']) throw new Error('Use --project or --all-projects, not both.');
  if (!['all', 'frontend', 'frontend-repair', 'deployment'].includes(values.type!)) throw new Error('Unsupported task type.');
  if (!['codex', 'claude'].includes(values.agent!)) throw new Error('--agent must be codex or claude.');
  const window0 = queryWindow(values, Date.now());
  if (values.agent === 'claude') return claudeMain(values, window0, began);
  const home = resolve(values.home!), project = values['all-projects'] ? undefined : resolve(values.project ?? process.cwd());
  const window = window0, accountId = readAccountId(home);
  const { tasks, diagnostics, index } = await readSpeedRecords(home, accountId, window.since, window.until, project);
  const quotaRecords = await readRecords(home, accountId, window.since, window.until);
  const weeklyQuota = prepareWeeklyQuota(quotaRecords, window.since, window.until);
  const accountUsage = await readSpeedRecords(home, accountId, window.since, window.until, undefined, { includeSubagents: true });
  weeklyQuota.calibration = calibrateQuota(weeklyQuota, accountUsage.tasks, accountUsage.diagnostics);
  if (readAccountId(home) !== accountId) throw new Error('Account changed during local record read; rerun.');
  const report = buildSpeedReport(tasks, diagnostics, { ...window, project, type: values.type as TaskType,
    fingerprint: createHash('sha256').update(accountId).digest('hex').slice(0, 12), index, details: values.details!, weeklyQuota });
  if (!report.verification.componentsValid || !report.verification.sourcesCovered) throw new Error('Timing validation failed.');
  process.stdout.write(`${JSON.stringify({ ...report, queryMs: Math.round(performance.now() - began) }, null, 2)}\n`);
}

async function claudeMain(values: Record<string, any>, window: ReturnType<typeof queryWindow>, began: number) {
  const home = resolve(values['claude-home']), project = values['all-projects'] ? undefined : resolve(values.project ?? process.cwd());
  const accountId = readClaudeAccountId(home);
  const { tasks, diagnostics, index } = await readClaudeRecords(home, window.since, window.until, project);
  if (readClaudeAccountId(home) !== accountId) throw new Error('Account changed during local record read; rerun.');
  const report = buildSpeedReport(tasks, diagnostics, { ...window, project, type: values.type as TaskType, agent: 'claude',
    fingerprint: createHash('sha256').update(accountId).digest('hex').slice(0, 12), index, details: values.details });
  if (!report.verification.componentsValid || !report.verification.sourcesCovered) throw new Error('Timing validation failed.');
  process.stdout.write(`${JSON.stringify({ ...report, queryMs: Math.round(performance.now() - began) }, null, 2)}\n`);
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry && (import.meta.url === pathToFileURL(entry).href
  || (existsSync(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href))) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'unavailable', error: error instanceof Error ? error.message : 'Unexpected failure' })}\n`);
    process.exitCode = 1;
  }
}
