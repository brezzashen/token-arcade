/** Reads Claude subscription usage with the selected profile's existing OAuth login, preferring macOS Keychain. Returns sanitized current windows, including server-scoped model limits; never persists credentials or retries rate limits. A fresh `rate-limits.json` that the shared statusline script writes from Claude Code's own `rate_limits` answers without any request, and one up to `STATUSLINE_FALLBACK_MS` old answers when the endpoint fails (it often returns 429), older ones never stand in for current quota; windows past their reset are dropped, never extrapolated. `ignoreEnvCredentials` restricts a read to that profile's own stored login, which `account-registry.ts` requires so one ambient token cannot answer for five accounts. claude-records.test.ts covers normalization and authentication isolation. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { refreshClaudeLogin } from './claude-login-refresh.ts';

type Credential = { accessToken: string; expiresAt?: number; subscriptionType?: string };
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** A statusline reading younger than this replaces the usage request entirely. */
export const STATUSLINE_FRESH_MS = 5 * 60_000;
/** When the usage request fails, a statusline reading up to this old still answers, labeled with its observedAt. */
export const STATUSLINE_FALLBACK_MS = 15 * 60_000;

export function claudeKeychainService(configDir: string, home = homedir()) {
  const path = resolve(configDir);
  return `Claude Code-credentials${path === resolve(home, '.claude') ? ''
    : `-${createHash('sha256').update(path).digest('hex').slice(0, 8)}`}`;
}

export type ClaudeQuotaOptions = {
  /** Reads only this profile's own stored login, so a multi-account view cannot report one ambient token five times. */
  ignoreEnvCredentials?: boolean;
  /** Lets the Claude CLI renew an expired stored login once before the read gives up (claude-login-refresh.ts). */
  refreshExpiredLogin?: (configDir: string) => boolean;
  /** Queries the usage endpoint even when statusline is fresh so server-scoped model limits (Fable) stay updated. */
  preferServer?: boolean;
  now?: number;
};

function credential(configDir: string, { ignoreEnvCredentials = false, refreshExpiredLogin }: ClaudeQuotaOptions = {}): Credential {
  if (!ignoreEnvCredentials) {
    if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(k => process.env[k] === '1')
      || process.env.ANTHROPIC_API_KEY) throw new Error('Claude subscription quota unavailable for API/cloud authentication.');
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }
  const usable = storedCredentials(configDir);
  if (usable.length) return usable[0];
  const renewed = refreshExpiredLogin?.(configDir) ? storedCredentials(configDir) : [];
  if (!renewed.length) throw new Error('No unexpired OAuth credentials in this Claude profile; refresh its Claude CLI login.');
  return renewed[0];
}

function storedCredentials(configDir: string): Credential[] {
  const candidates: Credential[] = [];
  if (process.platform === 'darwin') {
    try {
      candidates.push(JSON.parse(execFileSync('security', ['find-generic-password', '-s', claudeKeychainService(configDir), '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })).claudeAiOauth);
    } catch { /* A file-backed login is also supported. */ }
  }
  try { candidates.push(JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')).claudeAiOauth); }
  catch { /* Credentials may exist only in Keychain. */ }
  return candidates.filter(c => c && typeof c.accessToken === 'string' && c.accessToken
    && (c.expiresAt === undefined || Number.isFinite(c.expiresAt) && c.expiresAt > Date.now()));
}

export function normalizeClaudeQuota(raw: any, at = Date.now()) {
  const windows: Array<{ window: string; windowMinutes: number; usedPercent: number; remainingPercent: number;
    resetsAt: string | null; modelScope: { id: string | null; label: string | null } | null; surfaceScope: string | null;
    weeklyShare: { usedPercent: number | null; allowancePercent: number | null } | null }> = [];
  let invalidWindows = 0;
  const shares = Array.isArray(raw?.weekly_scoped_shares) ? raw.weekly_scoped_shares : [];
  const add = (key: string, minutes: number, percent: unknown, reset: unknown, scope: any = null, share: any = null) => {
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      invalidWindows++; return;
    }
    const resetMs = typeof reset === 'string' ? Date.parse(reset) : NaN;
    if (reset !== null && reset !== undefined && !Number.isFinite(resetMs)) { invalidWindows++; return; }
    const shareUsed = typeof share?.used_percent_of_weekly === 'number' && Number.isFinite(share.used_percent_of_weekly)
      ? share.used_percent_of_weekly : null;
    const shareCap = typeof share?.allowance_percent_of_weekly === 'number' && Number.isFinite(share.allowance_percent_of_weekly)
      ? share.allowance_percent_of_weekly : null;
    windows.push({ window: key, windowMinutes: minutes, usedPercent: percent, remainingPercent: 100 - percent,
      resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
      modelScope: scope?.model ? { id: typeof scope.model.id === 'string' ? scope.model.id : null,
        label: typeof scope.model.display_name === 'string' ? scope.model.display_name : null } : null,
      surfaceScope: typeof scope?.surface === 'string' ? scope.surface : null,
      weeklyShare: shareUsed !== null || shareCap !== null ? { usedPercent: shareUsed, allowancePercent: shareCap } : null });
  };
  if (Array.isArray(raw?.limits) && raw.limits.length) {
    const weeklyReset = raw.limits.find((item: any) => item?.kind === 'weekly_all')?.resets_at ?? null;
    for (const [i, limit] of raw.limits.entries()) {
      if (!['session', 'weekly_all', 'weekly_scoped'].includes(limit?.kind)) { invalidWindows++; continue; }
      const share = shares.find((item: any) => item?.limit_index === i) ?? null;
      const reset = limit.resets_at ?? (limit.kind === 'weekly_scoped' ? weeklyReset : null);
      add(`claude:${limit.kind}:${i}`, limit.kind === 'session' ? 300 : 10080, limit.percent, reset, limit.scope, share);
    }
  } else {
    for (const [key, label] of [['five_hour', null], ['seven_day', null], ['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const) {
      const value = raw?.[key];
      if (value) add(`claude:${key}`, key === 'five_hour' ? 300 : 10080, value.utilization, value.resets_at,
        label ? { model: { display_name: label } } : null);
    }
  }
  const extra = raw?.extra_usage;
  return { status: windows.length ? invalidWindows ? 'partial' : 'observed' : 'unavailable',
    capturedAt: new Date(at).toISOString(), source: CLAUDE_USAGE_URL, windows, invalidWindows,
    separateCredits: extra ? { enabled: extra.is_enabled === true,
      usedCredits: Number.isFinite(extra.used_credits) ? extra.used_credits : null,
      monthlyLimit: Number.isFinite(extra.monthly_limit) ? extra.monthly_limit : null,
      currency: typeof extra.currency === 'string' ? extra.currency : null } : null,
    limitations: ['Account-wide plan percentages are not per-model token bills. Only explicit server model scopes establish a model limit.',
      'This is the Claude CLI usage endpoint, not a stable public API contract. The only fallback is the statusline reading, labeled by source and observedAt; no fixed token-to-quota conversion is used.'] };
}

/** Reads `<configDir>/rate-limits.json` (statusline copy of Claude Code's `rate_limits`); null when absent, malformed or fully past reset. */
export function readStatuslineQuota(configDir: string, now = Date.now()) {
  let snapshot: any;
  try { snapshot = JSON.parse(readFileSync(join(configDir, 'rate-limits.json'), 'utf8')); } catch { return null; }
  const observedMs = Date.parse(snapshot?.capturedAt);
  if (!Number.isFinite(observedMs) || observedMs > now + 60_000) return null;
  const raw: Record<string, { utilization: unknown; resets_at: string | null }> = {};
  for (const key of ['five_hour', 'seven_day'] as const) {
    const value = snapshot.rate_limits?.[key];
    const resetMs = typeof value?.resets_at === 'number' ? value.resets_at * 1000 : NaN;
    // A window that has reset since the reading no longer describes current usage.
    if (value && Number.isFinite(resetMs) && resetMs > now) {
      raw[key] = { utilization: value.used_percentage, resets_at: new Date(resetMs).toISOString() };
    }
  }
  const quota = normalizeClaudeQuota(raw, now);
  if (!quota.windows.length) return null;
  return { ...quota, source: 'claude-code-statusline', observedAt: new Date(observedMs).toISOString() };
}

export async function fetchClaudeQuota(configDir: string, options: ClaudeQuotaOptions = {}) {
  const now = options.now ?? Date.now();
  const passive = readStatuslineQuota(configDir, now);
  let plan = 'unknown';
  try {
    const auth = credential(configDir, options);
    plan = auth.subscriptionType ?? 'unknown';
    if (!options.preferServer && passive && now - Date.parse(passive.observedAt) < STATUSLINE_FRESH_MS) {
      return { ...passive, planReportedByCredentials: plan };
    }
    return { ...await requestClaudeQuota(auth), planReportedByCredentials: plan };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Claude usage request failed.';
    if (!passive) throw error;
    if (now - Date.parse(passive.observedAt) > STATUSLINE_FALLBACK_MS) {
      throw new Error(`${message} The last statusline reading (${passive.observedAt}) is too old to stand in for current quota.`);
    }
    return { ...passive, planReportedByCredentials: plan, endpointError: message };
  }
}

async function requestClaudeQuota(auth: Credential) {
  let response: Response;
  try {
    response = await fetch(CLAUDE_USAGE_URL, { headers: { Authorization: `Bearer ${auth.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch { throw new Error('Claude usage request failed or timed out.'); }
  if (!response.ok) throw new Error(`Claude usage HTTP ${response.status}${response.status === 429 ? '; do not poll or retry immediately' : ''}.`);
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new Error('Claude usage returned invalid JSON.'); }
  const quota = normalizeClaudeQuota(raw);
  return { ...quota, observedAt: quota.capturedAt };
}
