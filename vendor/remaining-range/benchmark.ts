/** Runs one short code-analysis turn per Codex model/tier and Claude model from a frozen source snapshot. token-speed.ts and opt-in range.ts callers share the runner; passive queries make no model calls. */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { freezeInput } from './benchmark-input.ts';
import { openBenchmarkRpc } from './benchmark-rpc.ts';
import { measureTrial, skippedTrial, summarizeTrials } from './benchmark-measure.ts';
import type { Trial } from './benchmark-measure.ts';
import { readAccountId } from './quota.ts';
import { normalizeTier } from './speed-cost.ts';
import { claudeIdentity, measureClaudeTrial } from './benchmark-claude.ts';

const supportedModels = ['gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];

export const benchmarkOptions = {
  project: { type: 'string' as const }, file: { type: 'string' as const },
  models: { type: 'string' as const, default: supportedModels.join(',') },
  mode: { type: 'string' as const, default: 'both' }, effort: { type: 'string' as const, default: 'high' },
  rounds: { type: 'string' as const, default: '1' }, 'timeout-seconds': { type: 'string' as const, default: '180' },
  'start-line': { type: 'string' as const, default: '1' }, lines: { type: 'string' as const, default: '120' },
  'claude-home': { type: 'string' as const }, 'claude-budget-usd': { type: 'string' as const, default: '0.20' },
  'dry-run': { type: 'boolean' as const, default: false },
};

export function parseBenchmarkOptions(values: Record<string, unknown>) {
  const models = String(values.models ?? benchmarkOptions.models.default).split(',');
  if (!models.length || new Set(models).size !== models.length || models.some(m => !supportedModels.includes(m))) {
    throw new Error(`models_must_be_unique_from_${supportedModels.join(',')}`);
  }
  const mode = String(values.mode ?? 'both'), effort = String(values.effort ?? benchmarkOptions.effort.default);
  if (!['both', 'standard', 'fast'].includes(mode)) throw new Error('mode_must_be_both,standard,fast');
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('effort_must_be_low,medium,high,xhigh');
  const rounds = Number(values.rounds ?? 1), timeout = Number(values['timeout-seconds'] ?? 180);
  if (rounds !== 1) throw new Error('rounds_must_be_1_to_avoid_repeated_model_calls');
  if (!Number.isSafeInteger(timeout) || timeout < 15 || timeout > 300) throw new Error('timeout-seconds_must_be_15_to_300');
  const claudeBudgetUsd = Number(values['claude-budget-usd'] ?? 0.20);
  if (!Number.isFinite(claudeBudgetUsd) || claudeBudgetUsd <= 0 || claudeBudgetUsd > 0.20) throw new Error('claude-budget-usd_must_be_above_0_and_at_most_0.20');
  return { models, modes: mode === 'both' ? ['standard', 'fast'] : [mode], effort, rounds, timeoutMs: timeout * 1000, claudeBudgetUsd,
    home: resolve(String(values.home ?? process.env.CODEX_HOME ?? `${homedir()}/.codex`)),
    claudeHome: values['claude-home'] ? resolve(String(values['claude-home'])) : undefined,
    project: resolve(String(values.project ?? process.cwd())), file: values.file ? String(values.file) : undefined,
    startLine: Number(values['start-line'] ?? 1), lines: Number(values.lines ?? 120), dryRun: values['dry-run'] === true };
}
export type BenchmarkOptions = ReturnType<typeof parseBenchmarkOptions>;
type CatalogModel = { model: string; serviceTiers?: { id: string }[]; additionalSpeedTiers?: string[];
  supportedReasoningEfforts?: { reasoningEffort: string }[] };

export function trialSchedule(options: Pick<BenchmarkOptions, 'models' | 'modes' | 'rounds'>) {
  const schedule: { model: string; mode: string; round: number; order: number }[] = [];
  options.models.forEach((model, index) => {
    const modes = model.startsWith('claude-') ? ['standard'] : index % 2 ? [...options.modes].reverse() : options.modes;
    for (const mode of modes) schedule.push({ model, mode, round: 1, order: schedule.length + 1 });
  });
  return schedule;
}

function quotaSnapshot(raw: any) {
  const buckets = raw.rateLimitsByLimitId ?? { [raw.rateLimits?.limitId ?? 'codex']: raw.rateLimits };
  return Object.entries(buckets).flatMap(([bucket, value]) => ['primary', 'secondary'].flatMap(slot => {
    const w = (value as any)?.[slot];
    return w && Number.isFinite(w.usedPercent) ? [{ bucket, slot, usedPercent: w.usedPercent,
      minutes: w.windowDurationMins, resetsAt: w.resetsAt }] : [];
  }));
}

export async function runBenchmark(options: BenchmarkOptions, progress: (text: string) => void = () => {}) {
  const startedAt = new Date().toISOString(), input = freezeInput(options.project, options.file, options.startLine, options.lines);
  const schedule = trialSchedule(options);
  const plan = { startedAt, effort: options.effort, rounds: options.rounds, input: input.metadata, schedule,
    metrics: { firstTextMs: 'Codex: turn/start send to first visible text; Claude: CLI spawn to first visible text; includes initial reasoning/network',
      visibleTokensPerSecond: '(provider outputTokens - reasoningOutputTokens) / (last - first visible chunk seconds); client-observed approximate streaming rate',
      elapsedMs: 'Codex: turn/start to turn/completed, excluding setup; Claude: CLI process lifetime, including setup',
      speedBasis: 'request unless per-response served tier is explicitly recorded; configured tier is not served-tier proof' },
    limitations: ['Serial fresh ephemeral threads, one response per trial; identical prompt and common effort.',
      'First chunk tokens are included; transport buffering and prompt-cache warmth can affect results.',
      'Exactly one turn per selected model/mode, no benchmark retries or repeated rounds; Claude uses Standard only.',
      'Claude output cap=1200 tokens, high default effort, CLI estimated-spend stop threshold<=USD 0.20 per call. The in-flight call can exceed that threshold.',
      'Live calls consume their respective account allowance. No benchmark reports, prompts or analysis are saved by this script.'] };
  if (options.dryRun) return { ...plan, status: 'dry_run' as const };
  progress(`Source ${input.metadata.sourcePath}:${input.metadata.startLine}-${input.metadata.endLine}; ${schedule.length} serial calls, effort=${options.effort}.`);
  const hasCodex = schedule.some(t => !t.model.startsWith('claude-'));
  const accountId = hasCodex ? readAccountId(options.home) : null;
  const rpc = hasCodex ? await openBenchmarkRpc(options.home, options.project) : null;
  let cancelled = false;
  const cancel = () => { cancelled = true; rpc?.close(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const account = rpc ? (await rpc.call('account/read', { refreshToken: false })).account : null;
    if (rpc && account?.type !== 'chatgpt') throw new Error('benchmark_requires_current_chatgpt_subscription');
    const configured = rpc ? await rpc.call('config/read', { includeLayers: false, cwd: options.project }) : {};
    const disabledMcpServers = Object.keys(configured.config?.mcp_servers ?? {});
    const models: CatalogModel[] = [];
    let cursor: string | null = null;
    if (rpc) do {
      const page = await rpc.call('model/list', { limit: 100, cursor, includeHidden: true });
      models.push(...page.data); cursor = page.nextCursor;
    } while (cursor);
    const quotaBefore = rpc ? quotaSnapshot(await rpc.call('account/rateLimits/read')) : [];
    let stopped: string | null = quotaBefore.some(w => w.usedPercent >= 100) ? 'quota_exhausted_before_benchmark' : null;
    let claudeFingerprint: string | null = null, claudeStopped: string | null = null;
    if (schedule.some(t => t.model.startsWith('claude-'))) {
      try { claudeFingerprint = claudeIdentity(options.claudeHome); } catch { claudeStopped = 'claude_auth_unavailable'; }
    }
    const trials: Trial[] = [];
    for (const trial of schedule) {
      if (trial.model.startsWith('claude-')) {
        progress(`[${trial.order}/${schedule.length}] ${trial.model} standard: one turn, budget threshold=$${options.claudeBudgetUsd}`);
        const skip = cancelled ? 'benchmark_cancelled' : claudeStopped;
        const result = skip ? skippedTrial(trial.model, 'standard', options.effort, 1, trial.order, skip)
          : await measureClaudeTrial({ ...trial, effort: options.effort, prompt: input.prompt, project: options.project,
            home: options.claudeHome, timeoutMs: options.timeoutMs, budgetUsd: options.claudeBudgetUsd });
        trials.push(result);
        progress(`${trial.model}: ${result.status === 'ok' ? `${result.visibleTokensPerSecond!.toFixed(1)} tok/s` : result.reason}`);
        if (result.reason === 'trial_timeout') claudeStopped = 'trial_timeout';
        continue;
      }
      const model = models.find(m => m.model === trial.model);
      const tierIds = [...(model?.serviceTiers ?? []).map(t => t.id), ...(model?.additionalSpeedTiers ?? [])];
      const unavailable = (cancelled ? 'benchmark_cancelled' : stopped) ?? (!model ? 'model_not_available' :
        !model.supportedReasoningEfforts?.some(e => e.reasoningEffort === options.effort) ? 'effort_not_supported' :
          trial.mode === 'fast' && !tierIds.some(t => normalizeTier(t) === 'fast') ? 'fast_not_in_model_catalog' : null);
      let result: Trial;
      if (unavailable) result = skippedTrial(trial.model, trial.mode, options.effort, trial.round, trial.order, unavailable);
      else {
        progress(`[${trial.order}/${schedule.length}] ${trial.model} ${trial.mode} round=${trial.round} running`);
        try { result = await measureTrial(rpc!, { ...trial, effort: options.effort, timeoutMs: options.timeoutMs,
          prompt: input.prompt, cwd: options.project, disabledMcpServers }); }
        catch (error) { result = skippedTrial(trial.model, trial.mode, options.effort, trial.round, trial.order,
          error instanceof Error ? error.message : 'trial_failed'); }
      }
      trials.push(result);
      progress(`[${trial.order}/${schedule.length}] ${trial.model} ${trial.mode}: ${result.status === 'ok'
        ? `${result.visibleTokensPerSecond!.toFixed(1)} tok/s, first text ${(result.firstTextMs! / 1000).toFixed(1)}s`
        : result.reason}`);
      if (readAccountId(options.home) !== accountId) throw new Error('account_changed_during_benchmark');
      if (!unavailable) {
        const quota = quotaSnapshot(await rpc!.call('account/rateLimits/read'));
        if (quota.some(w => w.usedPercent >= 100)) stopped = 'quota_exhausted';
        if (/app_server|trial_timeout|usageLimitExceeded|rateLimitExceeded|sessionBudgetExceeded|unauthorized/.test(result.reason ?? '')) stopped = result.reason;
      }
    }
    const quotaAfter = rpc ? quotaSnapshot(await rpc.call('account/rateLimits/read')) : [];
    return { ...plan, status: (trials.every(t => t.status === 'ok') ? 'ok' : 'partial') as 'ok' | 'partial', completedAt: new Date().toISOString(),
      accountFingerprint: accountId ? createHash('sha256').update(accountId).digest('hex').slice(0, 12) : null, claudeAccountFingerprint: claudeFingerprint,
      quota: { before: quotaBefore, after: quotaAfter, scope: 'Account snapshots; overlapping work and rounded percentages prevent benchmark-only billing attribution.' },
      trials, ...summarizeTrials(trials) };
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); rpc?.close();
  }
}

export function formatBenchmark(report: Awaited<ReturnType<typeof runBenchmark>>) {
  const title = `Model output benchmark | effort=${report.effort} | single-turn samples\nSource: ${report.input.sourcePath}:${report.input.startLine}-${report.input.endLine}\nPrompt SHA256: ${report.input.promptSha256}`;
  if (report.status === 'dry_run') return `${title}\nDry run: ${report.schedule.length} planned calls; no model or quota RPC.\n${report.schedule.map(t => `${t.order}. ${t.model} ${t.mode}`).join('\n')}`;
  const value = (n: number | null, scale = 1) => n === null ? 'N/A' : (n / scale).toFixed(1);
  const rows = report.groups.map(g => `| ${g.model} | ${g.mode} | ${g.samples}/${g.attempted} | ${value(g.medianTokensPerSecond)} | ${value(g.medianFirstTextMs, 1000)} | ${value(g.medianElapsedMs, 1000)} | ${g.speedBasis} |`);
  const comparisons = report.comparisons.filter(c => !c.model.startsWith('claude-')).map(c => `${c.model}: Fast/Standard ${c.fastOutputSpeedRatio === null ? 'N/A' : `${c.fastOutputSpeedRatio.toFixed(2)}x`} (${c.pairedRounds} paired rounds)`);
  const failures = report.groups.flatMap(g => g.failures.map(f => `${g.model} ${g.mode}: ${f}`));
  return `${title}\n\n| Model | Mode | Valid/attempted | Output tok/s | First text s | Total s | Tier basis |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n${comparisons.join('\n')}\n${failures.join('\n')}\n\nClient-observed rate excludes reasoning tokens. Tier basis=request does not prove the served tier. Each sample is one short code-analysis turn. Claude total/first-text time includes CLI setup.`;
}
