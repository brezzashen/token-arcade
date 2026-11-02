/** Public report projection for range.ts; only aggregate usage enters the browser. */
import { geminiSubscriptionPlan, geminiVertexPlan } from './subscription.ts';
export const accountAliases = ['cc1', 'cc2', 'cc3', 'cc4', 'cc5', 'co1', 'co2', 'grok', 'ag1', 'ag2'] as const;
export type Alias = typeof accountAliases[number];
/** Accounts read when TOKEN_ACCOUNTS is unset: the default Claude Code and Codex logins. */
export const defaultAccounts = 'cc1,co1';
type RecordValue = Record<string, any>;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null => typeof value === 'string' ? value.slice(0, 180) : null;
const rows = (value: unknown): RecordValue[] => Array.isArray(value) ? value : [];

export function parseAccounts(value = accountAliases.join(',')): Alias[] {
  const aliases = [...new Set(value.split(',').map(item => item.trim() === 'gm' ? 'ag1' : item.trim() === 'gm2' ? 'ag2' : item.trim()))];
  if (!aliases.length || aliases.some(alias => !accountAliases.includes(alias as Alias))) {
    throw new Error('TOKEN_ACCOUNTS must contain registered account aliases.');
  }
  return aliases as Alias[];
}

function usage(row: RecordValue = {}) {
  return { id: text(row.id), model: text(row.model), start: text(row.start), end: text(row.end),
    status: text(row.status), totalTokens: finite(row.totalTokens), inputTokens: finite(row.inputTokens),
    cachedInputTokens: finite(row.cachedInputTokens), outputTokens: finite(row.outputTokens),
    reasoningOutputTokens: finite(row.reasoningOutputTokens),
    uncachedInputTokens: finite(row.uncachedInputTokens), cacheCreationInputTokens: finite(row.cacheCreationInputTokens),
    tokensPerWallClockHour: finite(row.tokensPerWallClockHour), tokensPerActiveHour: finite(row.tokensPerActiveHour),
    validResponses: finite(row.validResponses), invalidResponses: finite(row.invalidResponses),
    turnsWithoutUsage: finite(row.turnsWithoutUsage), recordGaps: row.recordGaps === true,
    cacheCreation1hInputTokens: finite(row.cacheCreation1hInputTokens),
    longContext: row.longContext ? { thresholdInputTokens: finite(row.longContext.thresholdInputTokens),
      inputTokens: finite(row.longContext.inputTokens), cachedInputTokens: finite(row.longContext.cachedInputTokens),
      cacheCreationInputTokens: finite(row.longContext.cacheCreationInputTokens),
      cacheCreation1hInputTokens: finite(row.longContext.cacheCreation1hInputTokens),
      outputTokens: finite(row.longContext.outputTokens) } : null };
}

export function projectReport(alias: Alias | 'gm' | 'gm2', report: RecordValue) {
  const normalized: Alias = alias === 'gm' ? 'ag1' : alias === 'gm2' ? 'ag2' : alias;
  const rawWindows = report.windows ?? report.quota?.windows ?? (report.quota?.periodType ? [report.quota] : []);
  const windows = rows(rawWindows).map((row: RecordValue) => {
    const remaining = finite(row.remainingPercent);
    return { name: text(row.window ?? row.periodType), minutes: finite(row.windowMinutes),
      model: text(row.modelScope?.label), surface: text(row.surfaceScope?.label ?? row.surfaceScope),
      scoped: row.modelScope != null || row.surfaceScope != null,
      usedPercent: finite(row.usedPercent) ?? (remaining === null ? null : 100 - remaining),
      remainingPercent: remaining, resetsAt: text(row.resetsAt),
      cycle: row.cycleTokens ? { ...usage(row.cycleTokens),
        tokensPerQuotaPercentagePoint: finite(row.cycleTokens.tokensPerQuotaPercentagePoint),
        projectedTokensPerFullWindow: finite(row.cycleTokens.projectedTokensPerFullWindow) } : null };
  });
  const error = report.quota?.error ?? report.error;
  const issue = typeof error === 'string' ? (/429/.test(error) ? '服务端限流' : /401|expir|auth|login|credential/i.test(error)
    ? '登录状态不可用' : '额度读取失败') : null;
  const billing = report.billing ? {
    costUsd: finite(report.billing.costUsd), dayCostUsd: finite(report.billing.dayCostUsd),
    currency: text(report.billing.currency) ?? 'USD',
    periodStart: text(report.billing.periodStart), periodEnd: text(report.billing.periodEnd),
    project: text(report.billing.project), validResponses: finite(report.billing.validResponses),
  } : null;
  return { alias: normalized, provider: normalized.startsWith('co') ? 'Codex' : normalized.startsWith('cc') ? 'Claude' : normalized.startsWith('ag') ? 'Gemini' : 'Grok',
    label: text(report.account?.label) ?? (normalized === 'ag1' ? 'ag1 · ultra' : normalized === 'ag2' ? 'ag2 · vertex' : normalized),
    fingerprint: text(report.accountFingerprint),
    plan: text(report.planReportedByServer ?? report.quota?.planReportedByCredentials ?? report.quota?.plan)
      ?? (normalized === 'ag1' ? geminiSubscriptionPlan : normalized === 'ag2' ? geminiVertexPlan : null),
    capturedAt: text(report.capturedAt), issue, windows, billing,
    // A statusline reading is Claude Code's own copy of the server windows; its age is shown beside it.
    // 'cached' is set only by quota-cache.ts when a failed read reuses the last reading of this cycle.
    quotaSource: (report.quota?.source === 'claude-code-statusline' ? 'statusline' : 'server') as 'statusline' | 'server' | 'cached',
    quotaObservedAt: text(report.quota?.observedAt ?? report.quota?.capturedAt),
    telemetryIssue: report.telemetryError === true ? '最近 24 小时的本机记录读取失败' : null,
    samples: rows(report.tokens?.samples).map(usage), models: rows(report.tokens?.byModel).map(usage),
    cache: rows(report.cache?.samples).map((row: RecordValue) => ({ id: text(row.id),
      tokenHitPercent: finite(row.tokenHitPercent) })),
    forecast: text(report.dashboard?.text),
    forecasts: rows(report.samples).map((row: RecordValue) => ({ id: text(row.id),
      text: text(row.dashboard?.text), windows: rows(row.windows).map((window: RecordValue) => ({
        name: text(window.window), start: text(window.sampleStart), end: text(window.sampleEnd),
        delta: finite(window.samplePercentagePoints), status: text(window.status),
        reason: text(window.reasonCode), extended: window.sampleBasis === 'extended_current_cycle_sample' })) })),
  };
}
export type AccountReport = ReturnType<typeof projectReport>;
