/**
 * CLI: one table of registered Claude/Codex accounts and the Grok CLI profile with its
 * current weekly quota used/remaining, reset time and session window, so the next task can be
 * started on the account that still has range.
 *
 * Reads `account-registry.ts` only; it owns alias resolution, per-profile authentication isolation
 * and failure isolation. Unlike `range.ts`, which produces one profile's deep report with token
 * records and a forecast, this entry point is breadth-first and makes no local record scan, no
 * model call and no forecast. It prints and saves nothing; `--dry-run` proves that by listing the
 * plan without any quota RPC. `accounts.test.ts` covers rendering, selection and the dry run.
 */
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { type AccountQuota, type QuotaWindow, readAccountsQuota, selectAccounts } from './account-registry.ts';

const SCOPE = 'Separate accounts, providers and quota windows; percentages are never added across rows.';

function resetText(window: QuotaWindow | null, timezone: string, now: number) {
  if (!window?.resetsAt) return '-';
  const at = Date.parse(window.resetsAt);
  if (!Number.isFinite(at)) return '-';
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(at).replace(',', '');
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 0) return `${stamp} (passed)`;
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return `${stamp} (in ${days ? `${days}d ` : ''}${hours}h${days ? '' : ` ${minutes % 60}m`})`;
}

const percent = (value: number | null | undefined) => typeof value === 'number' ? `${Math.round(value)}%` : '-';

function renderTable(rows: string[][]) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => row[i].length)));
  return rows.map((row, index) => {
    const line = row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
    return index === 0 ? `${line}\n${widths.map(w => '-'.repeat(w)).join('  ')}` : line;
  }).join('\n');
}

function render(accounts: AccountQuota[], timezone: string, now: number) {
  const header = ['ALIAS', 'AGENT', 'PROFILE', 'PLAN', 'ACCOUNT', 'WEEKLY USED', 'WEEKLY LEFT', 'WEEKLY RESET', 'SESSION LEFT', 'STATUS'];
  const rows = accounts.map(account => [
    account.alias, account.agent, account.profile, account.plan ?? '-', account.identityHint ?? account.fingerprint ?? '-',
    percent(account.weekly?.usedPercent), percent(account.weekly?.remainingPercent),
    resetText(account.weekly, timezone, now),
    account.session ? percent(account.session.remainingPercent) : '-',
    account.status === 'unavailable' ? 'unavailable' : account.status,
  ]);
  const lines = [renderTable([header, ...rows])];
  const scoped = accounts.flatMap(a => a.scoped.filter(w => w.usedPercent > 0)
    .map(w => `  ${a.alias} ${w.modelScope?.label ?? w.window}: used ${percent(w.usedPercent)}, resets ${resetText(w, timezone, now)}`));
  if (scoped.length) lines.push('', 'Model-scoped windows (server-scoped only, never part of the account-wide weekly figure):', ...scoped);
  const monthly = accounts.flatMap(a => a.windows.filter(w => w.window === 'grok:monthly')
    .map(w => `  ${a.alias}: used ${percent(w.usedPercent)}, left ${percent(w.remainingPercent)}, resets ${resetText(w, timezone, now)}`));
  if (monthly.length) lines.push('', 'Monthly allowance (separate from weekly quota):', ...monthly);
  const problems = accounts.filter(a => a.error || a.hint);
  if (problems.length) {
    lines.push('', 'Unavailable:', ...problems.map(a => `  ${a.alias}: ${a.error ?? 'unavailable'}${a.hint ? ` -> ${a.hint}` : ''}`));
  }
  lines.push('', `Captured ${new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(now)} ${timezone}. ${SCOPE}`);
  return lines.join('\n');
}

try {
  const { values } = parseArgs({ options: {
    agent: { type: 'string', default: 'all' },
    only: { type: 'string' },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    sort: { type: 'string', default: 'alias' },
    timezone: { type: 'string', default: 'Asia/Singapore' },
    home: { type: 'string', default: homedir() },
    'dry-run': { type: 'boolean', default: false },
  } });
  if (!['codex', 'claude', 'both', 'grok', 'gemini', 'all'].includes(values.agent!)) throw new Error('agent must be codex, claude, both, grok, gemini or all.');
  if (!['alias', 'remaining'].includes(values.sort!)) throw new Error('sort must be alias or remaining.');
  const timezone = values.timezone!;
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  const refs = selectAccounts({ agent: values.agent as 'all', only: values.only?.split(','), all: values.all, home: values.home });
  if (!refs.length) throw new Error('No accounts selected.');
  if (values['dry-run']) {
    const plan = { title: 'Local agent accounts (plan only)', scope: SCOPE, timezone, accounts: refs };
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    const accounts = await readAccountsQuota(refs, { home: values.home });
    if (values.sort === 'remaining') {
      accounts.sort((a, b) => (b.weekly?.remainingPercent ?? -1) - (a.weekly?.remainingPercent ?? -1) || a.alias.localeCompare(b.alias));
    }
    const now = Date.now();
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ title: 'Local agent accounts weekly quota', capturedAt: new Date(now).toISOString(),
        timezone, scope: SCOPE, accounts }, null, 2)}\n`);
    } else process.stdout.write(`${render(accounts, timezone, now)}\n`);
    if (!accounts.some(a => a.status !== 'unavailable')) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'unavailable', error: error instanceof Error ? error.message : 'Unexpected failure' })}\n`);
  process.exitCode = 1;
}
