/** CLI: reads separate Codex/Claude quota and token reports plus Grok subscription quota.
 * --agent both keeps the Codex/Claude pair; all includes Grok. Codex remains the default.
 * --account resolves a profile through account-registry.ts; accounts.ts is the breadth view.
 * grok-quota.ts never infers token allowance or hours from subscription percentages.
 * Only an explicit --agent codex --benchmark starts model calls. */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fetchQuota } from './quota.ts';
import { dayStart, readRecords } from './records.ts';
import { buildReport } from './forecast.ts';
import { buildCacheReport } from './cache-report.ts';
import { buildTokenReport, cycleTokenConsumption, quotaTokenConsumption } from './token-report.ts';
import { buildClaudeRange, buildGeminiRange } from './claude-range.ts';
import { accountLabel, resolveAccountOption } from './account-registry.ts';
import { fetchClaudeQuota } from './claude-quota.ts';
import { refreshClaudeLogin } from './claude-login-refresh.ts';
import { buildGrokRange } from './grok-quota.ts';
import { benchmarkOptions, parseBenchmarkOptions, runBenchmark } from './benchmark.ts';

try {
  const { values } = parseArgs({ options: {
    ...benchmarkOptions,
    benchmark: { type: 'boolean', default: false },
    account: { type: 'string' },
    agent: { type: 'string', default: 'codex' },
    'prefer-server': { type: 'boolean', default: false },
    'claude-home': { type: 'string', default: process.env.CLAUDE_CONFIG_DIR ?? `${homedir()}/.claude` },
    'gemini-home': { type: 'string', default: `${homedir()}/.config/cg4/claude-home` },
    'grok-home': { type: 'string', default: `${homedir()}/.grok` },
    home: { type: 'string', default: process.env.CODEX_HOME ?? `${homedir()}/.codex` },
    timezone: { type: 'string', default: 'Asia/Singapore' },
    'lookback-hours': { type: 'string', default: '1' },
  } });
  if (values.account) {
    if (process.argv.some(arg => ['--home', '--claude-home', '--gemini-home', '--grok-home'].some(option => arg === option || arg.startsWith(`${option}=`)))) {
      throw new Error('--account already selects a profile directory; drop --home / --claude-home / --gemini-home / --grok-home.');
    }
    const selected = resolveAccountOption(values.account);
    values.agent = selected.agent;
    if (selected.codexHome) values.home = selected.codexHome;
    else if (selected.claudeHome) values['claude-home'] = selected.claudeHome;
    else if (selected.geminiHome) values['gemini-home'] = selected.geminiHome;
    else values['grok-home'] = selected.grokHome!;
  }
  // A named alias must authenticate as that profile, never as an ambient session token.
  const preferServer = values['prefer-server'] === true;
  const claudeQuotaReader = values.account
    ? (configDir: string) => fetchClaudeQuota(configDir, { ignoreEnvCredentials: true, refreshExpiredLogin: refreshClaudeLogin, preferServer })
    : preferServer ? (configDir: string) => fetchClaudeQuota(configDir, { preferServer }) : fetchClaudeQuota;
  const home = resolve(values.home!);
  const timezone = values.timezone!;
  const lookbackHours = Number(values['lookback-hours']);
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0 || lookbackHours > 24) {
    throw new Error('lookback-hours must be greater than 0 and at most 24.');
  }
  dayStart(Date.now(), timezone);
  if (!['codex', 'claude', 'both', 'grok', 'gemini', 'all'].includes(values.agent!)) throw new Error('agent must be codex, claude, both, grok, gemini or all.');
  if (values.benchmark && values.agent !== 'codex') throw new Error('Use --agent codex for an explicit live benchmark.');
  if (values['dry-run'] && !values.benchmark) throw new Error('dry-run_requires_--benchmark');
  const benchmark = values.benchmark ? await runBenchmark(parseBenchmarkOptions(values),
    text => process.stderr.write(`${text}\n`)) : null;
  if (values['dry-run']) {
    if (!values.benchmark) throw new Error('dry-run_requires_--benchmark');
    process.stdout.write(`${JSON.stringify({ benchmark }, null, 2)}\n`);
  } else {
    const codexReport = async () => {
      const live = await fetchQuota(home);
      const start = dayStart(live.at, timezone);
      const records = await readRecords(home, live.accountId, start, live.at);
      const forecast = buildReport(live, records, start, timezone, lookbackHours);
      const withTokens = (windows: typeof forecast.windows) => windows.map(window => ({ ...window,
        tokens: quotaTokenConsumption(records, window) }));
      // Cumulative tokens since each window last reset; a weekly cycle reaches back before today.
      const cycleStart = Math.min(start, ...live.windows.map(w => Math.min(live.at, w.reset - w.minutes * 60_000)));
      const cycleRecords = cycleStart < start ? await readRecords(home, live.accountId, cycleStart, live.at) : records;
      const cycleTokens = new Map(live.windows.map(w => [w.key, cycleTokenConsumption(cycleRecords,
        { resetsAt: w.reset, windowMinutes: w.minutes, usedPercent: w.used }, live.at)]));
      return { ...forecast, agent: 'codex', account: accountLabel('codex', home),
        windows: withTokens(forecast.windows).map(w => ({ ...w, cycleTokens: cycleTokens.get(w.window) ?? null })),
        samples: forecast.samples.map(sample => ({ ...sample, windows: withTokens(sample.windows) })),
        cache: buildCacheReport(records, start, live.at, process.env.CODEX_THREAD_ID),
        tokens: buildTokenReport(records, start, live.at, process.env.CODEX_THREAD_ID),
        ...(benchmark ? { benchmark } : {}) };
    };
    const claudeHome = resolve(values['claude-home']!);
    const claudeReport = async () => ({ account: accountLabel('claude', claudeHome),
      ...await buildClaudeRange(claudeHome, timezone, claudeQuotaReader) });
    const grokHome = resolve(values['grok-home']!);
    const grokReport = async () => ({ account: accountLabel('grok', grokHome),
      ...await buildGrokRange(grokHome, timezone) });
    const geminiHome = resolve(values['gemini-home']!);
    const geminiReport = async () => ({ account: accountLabel('gemini', geminiHome),
      ...await buildGeminiRange(geminiHome, timezone) });
    let report: unknown;
    if (values.agent === 'codex') report = await codexReport();
    else if (values.agent === 'claude') report = await claudeReport();
    else if (values.agent === 'grok') report = await grokReport();
    else if (values.agent === 'gemini') report = await geminiReport();
    else {
      const agents: Record<string, unknown> = {};
      const selected = values.agent === 'all' ? ['codex', 'claude', 'grok', 'gemini'] : ['codex', 'claude'];
      const readers = { codex: codexReport, claude: claudeReport, grok: grokReport, gemini: geminiReport };
      const results = await Promise.allSettled(selected.map(agent => readers[agent as keyof typeof readers]()));
      results.forEach((result, i) => {
        const agent = selected[i];
        agents[agent] = result.status === 'fulfilled' ? result.value
          : { status: 'unavailable', error: result.reason instanceof Error ? result.reason.message : `${agent} unavailable.` };
      });
      report = { title: values.agent === 'all' ? 'Codex, Claude and Grok Remaining Range' : 'Codex and Claude Remaining Range', agents,
        scope: 'Separate accounts and provider tokenizers; totals and quota percentages are never added.' };
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (benchmark && benchmark.status !== 'dry_run' && !benchmark.trials.some(t => t.status === 'ok')) process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unexpected failure';
  process.stderr.write(`${JSON.stringify({ status: 'unavailable', error: message })}\n`);
  process.exitCode = 1;
}
