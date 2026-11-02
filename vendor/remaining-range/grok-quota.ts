/** Reads Grok Build subscription quota from one selected profile's stored first-party login.
 * Publishes sanitized billing windows for range.ts and account-registry.ts. This is quota only:
 * local tokens and development-hour forecasts are unavailable. Never refreshes rotating OAuth
 * tokens, persists data, starts a model call or retries HTTP failures. accounts.test.ts covers
 * period classification, credential isolation, missing data and private error-body exclusion.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuotaWindow } from './account-registry.ts';

export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const cents = (value: unknown) => {
  const cent = object(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Proto3 omits zero-valued scalar fields, so an empty Cent object is a measured zero.
  const val = cent.val === undefined ? 0 : typeof cent.val === 'string' && /^-?\d+$/.test(cent.val) ? Number(cent.val) : cent.val;
  return typeof val === 'number' && Number.isSafeInteger(val) ? Math.abs(val) : null;
};

function credential(configDir: string) {
  let stored: Record<string, unknown>;
  try { stored = object(JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf8'))); }
  catch { throw new Error('No readable Grok CLI login in this profile; run grok login.'); }
  const oidc = Object.entries(stored).filter(([scope]) => scope.startsWith('https://auth.x.ai::'));
  if (oidc.length > 1) throw new Error('Multiple Grok OAuth logins in this profile; quota account is ambiguous.');
  const auth = object(oidc[0]?.[1] ?? stored['https://accounts.x.ai/sign-in']);
  if (typeof auth.key !== 'string' || !auth.key || typeof auth.user_id !== 'string' || !auth.user_id) {
    throw new Error('No first-party Grok subscription login in this profile; run grok login.');
  }
  if (auth.expires_at !== undefined && (!timestamp(auth.expires_at) || Date.parse(auth.expires_at as string) <= Date.now())) {
    throw new Error('Grok OAuth login expired; run grok models to let the CLI renew it, then rerun.');
  }
  return { key: auth.key, userId: auth.user_id, email: typeof auth.email === 'string' ? auth.email : null };
}

export function normalizeGrokQuota(raw: unknown, at = Date.now()) {
  const response = object(raw), config = object(response.config), period = object(config.currentPeriod);
  const legacy = config.creditUsagePercent === undefined && config.currentPeriod === undefined
    && config.monthlyLimit !== undefined && config.used !== undefined;
  const limit = cents(config.monthlyLimit), used = cents(config.used);
  const percent = legacy && limit !== null && limit > 0 && used !== null
    ? Math.min(100, used / limit * 100) : number(config.creditUsagePercent);
  const validPercent = percent !== null && percent >= 0 && percent <= 100;
  const periodType = legacy ? 'USAGE_PERIOD_TYPE_MONTHLY' : typeof period.type === 'string' ? period.type : null;
  const startsAt = timestamp(legacy ? config.billingPeriodStart : period.start);
  const resetsAt = timestamp(legacy ? config.billingPeriodEnd : period.end);
  const duration = startsAt && resetsAt ? (Date.parse(resetsAt) - Date.parse(startsAt)) / 60_000 : null;
  const weekly = periodType === 'USAGE_PERIOD_TYPE_WEEKLY', monthly = periodType === 'USAGE_PERIOD_TYPE_MONTHLY';
  const validPeriod = (weekly || monthly) && (duration === null || duration > 0)
    && (weekly || duration !== null);
  const windows: QuotaWindow[] = validPercent && validPeriod ? [{
    window: weekly ? 'grok:weekly' : 'grok:monthly', windowMinutes: weekly ? 10080 : duration!,
    usedPercent: percent!, remainingPercent: 100 - percent!, resetsAt, modelScope: null, surfaceScope: null,
  }] : [];
  return { status: !validPercent ? 'unavailable' as const : !windows.length || !startsAt || !resetsAt ? 'partial' as const : 'observed' as const,
    capturedAt: new Date(at).toISOString(), source: GROK_BILLING_URL,
    usedPercent: validPercent ? percent : null, remainingPercent: validPercent ? 100 - percent! : null,
    periodType, startsAt, resetsAt, windows,
    plan: typeof response.subscriptionTier === 'string' ? response.subscriptionTier : null,
    separateCredits: { currency: 'USD', prepaidBalanceCents: cents(config.prepaidBalance),
      onDemandUsedCents: cents(config.onDemandUsed), onDemandCapCents: cents(config.onDemandCap),
      onDemandEnabled: typeof response.onDemandEnabled === 'boolean' ? response.onDemandEnabled : null },
    unifiedBilling: typeof config.isUnifiedBillingUser === 'boolean' ? config.isUnifiedBillingUser : null,
    limitations: ['Grok subscription percentages are account-wide; product usage shares are not separate model limits.',
      'This is the Grok Build CLI billing endpoint, not an xAI API-key balance or a stable public API.',
      'Weekly and monthly periods remain separate. Missing counters are unavailable, never zero or unlimited.'],
  };
}

export async function fetchGrokQuota(configDir: string, request: typeof fetch = fetch) {
  const auth = credential(configDir);
  let response: Response;
  try {
    response = await request(GROK_BILLING_URL, { headers: { Authorization: `Bearer ${auth.key}`,
      'X-XAI-Token-Auth': 'xai-grok-cli', 'x-userid': auth.userId },
      redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch { throw new Error('Grok billing request failed or timed out.'); }
  if (!response.ok) throw new Error(`Grok billing HTTP ${response.status}${response.status === 401
    ? '; renew the CLI login with grok models or grok login' : response.status === 429 ? '; do not poll or retry immediately' : ''}.`);
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new Error('Grok billing returned invalid JSON.'); }
  if (credential(configDir).userId !== auth.userId) throw new Error('Grok profile account changed during query; rerun.');
  const identityHint = auth.email ? auth.email.includes('@')
    ? auth.email.replace(/^([^@]{0,2})[^@]*@/, '$1***@') : `${auth.email.slice(0, 2)}***` : null;
  return { ...normalizeGrokQuota(raw), identityHint,
    accountFingerprint: createHash('sha256').update(auth.userId).digest('hex').slice(0, 12) };
}

export async function buildGrokRange(configDir: string, timezone: string) {
  const scope = 'No local Grok token scan or historical quota snapshots; development hours and token allowance are unavailable.';
  try {
    const quota = await fetchGrokQuota(configDir);
    return { title: 'Grok Remaining Range', agent: 'grok', timezone, capturedAt: quota.capturedAt,
      status: quota.status, accountFingerprint: quota.accountFingerprint, quota,
      tokens: { status: 'unavailable', reason: scope },
      dashboard: { status: 'unavailable', remainingMinutes: null, text: scope } };
  } catch (error) {
    return { title: 'Grok Remaining Range', agent: 'grok', timezone, capturedAt: new Date().toISOString(),
      status: 'unavailable', quota: { status: 'unavailable', error: error instanceof Error ? error.message : 'Grok quota unavailable.' },
      tokens: { status: 'unavailable', reason: scope },
      dashboard: { status: 'unavailable', remainingMinutes: null, text: scope } };
  }
}
