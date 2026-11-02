/**
 * Resolves the local agent-account profiles this machine is logged into (the `cc1`-`cc5` /
 * `co1`-`co2` shell aliases plus the Grok CLI profile) and reads one current quota snapshot per account, keeping every
 * account, provider and quota window separate.
 *
 * Depends on `grok-quota.ts` (stored Grok CLI login and one billing read), `claude-quota.ts` (OAuth usage endpoint) and
 * `quota.ts` (authenticated `codex app-server` RPC per Codex home); publishes `AccountRef`,
 * `AccountQuota`, the registry/discovery helpers and `readAccountsQuota` for `accounts.ts`, plus
 * `accountLabel`, which names the profile behind a `range.ts` report (`cc1 · admin`).
 * Unlike `range.ts`, which builds one deep report for the selected profile, this module is the
 * breadth view: current percentages only, no local token records and no forecast.
 *
 * Reading another profile must never authenticate as the current one: each account is read with
 * its own `CODEX_HOME` / config directory and with ambient `CLAUDE_CODE_OAUTH_TOKEN` and
 * `ANTHROPIC_API_KEY` ignored, so one logged-in session cannot be reported five times under five
 * aliases. `accounts.test.ts` freezes that isolation, the alias-to-home mapping and failure
 * isolation between accounts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fetchClaudeQuota } from './claude-quota.ts';
import { fetchQuota } from './quota.ts';
import { fetchGrokQuota } from './grok-quota.ts';

export type Agent = 'claude' | 'codex' | 'grok' | 'gemini';

export type AccountRef = {
  /** Account selector: cc1-cc5 (Claude), co1-co2 (Codex), grok (the CLI profile), or gm (Gemini 4 Argon via cg4). */
  alias: string;
  agent: Agent;
  /** Profile directory name (`default` for `~/.claude` and `~/.codex`). */
  profile: string;
  /** Absolute profile directory for this account. */
  home: string;
  /** Command that switches a shell to this account, for a re-login hint. */
  switchCommand: string;
  /** False for a profile directory found on disk that the alias registry does not name. */
  registered: boolean;
};

export type QuotaWindow = {
  window: string;
  windowMinutes: number;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  modelScope: { id: string | null; label: string | null } | null;
  surfaceScope: string | null;
};

export type AccountQuota = AccountRef & {
  status: 'observed' | 'partial' | 'unavailable';
  error: string | null;
  hint: string | null;
  plan: string | null;
  /** Masked local part of the profile's login, enough to recognise the account without printing it. */
  identityHint: string | null;
  fingerprint: string | null;
  capturedAt: string;
  /** Account-wide weekly allowance; Grok monthly periods are never placed here. */
  weekly: QuotaWindow | null;
  /** Shortest account-wide window below seven days, i.e. Claude's five-hour session window. */
  session: QuotaWindow | null;
  /** Server-scoped model windows, never merged into `weekly`. */
  scoped: QuotaWindow[];
  windows: QuotaWindow[];
  /** Codex credits / reset-count extras; Claude separate-credit balance. */
  extras: unknown;
};

const WEEK_MINUTES = 7 * 24 * 60;

/**
 * Named local profiles. cc1 is `~/.claude` and co1 is `~/.codex`; cc2-cc5 and co2 take the profile
 * directories named in `TOKEN_CLAUDE_PROFILES` / `TOKEN_CODEX_PROFILES` (comma-separated), or else the
 * first sub-directories of `~/.claude-profiles` / `~/.codex-profiles` in name order.
 * Grok uses its CLI command rather than an invented numbered alias.
 */
export function registeredAccounts(home = homedir(), env: NodeJS.ProcessEnv = process.env): AccountRef[] {
  const profiles = (variable: string, dir: string, slots: number) => {
    const named = env[variable]?.split(',').map(name => name.trim()).filter(Boolean);
    if (named?.length) return named.slice(0, slots);
    try { return readdirSync(join(home, dir), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().slice(0, slots); }
    catch { return []; }
  };
  const claude = (alias: string, profile: string, dir: string) => ({
    alias, agent: 'claude' as const, profile, home: join(home, dir),
    switchCommand: dir === '.claude' ? 'claude /login' : `CLAUDE_CONFIG_DIR=~/${dir} claude /login`, registered: true,
  });
  const codex = (alias: string, profile: string, dir: string) => ({
    alias, agent: 'codex' as const, profile, home: join(home, dir),
    switchCommand: dir === '.codex' ? 'codex login' : `CODEX_HOME=~/${dir} codex login`, registered: true,
  });
  return [
    claude('cc1', 'default', '.claude'),
    ...profiles('TOKEN_CLAUDE_PROFILES', '.claude-profiles', 4).map((name, i) => claude(`cc${i + 2}`, name, `.claude-profiles/${name}`)),
    codex('co1', 'default', '.codex'),
    ...profiles('TOKEN_CODEX_PROFILES', '.codex-profiles', 1).map(name => codex('co2', name, `.codex-profiles/${name}`)),
    { alias: 'grok', agent: 'grok', profile: 'main', home: join(home, '.grok'),
      switchCommand: 'grok login', registered: true },
    { alias: 'gm', agent: 'gemini', profile: 'argon', home: join(home, '.config/cg4/claude-home'),
      switchCommand: 'cg4', registered: true },
  ];
}

/** Profile directories present on disk that no alias names; shown only with --all so a stray login stays visible. */
export function discoverAccounts(home = homedir(), registry = registeredAccounts(home)): AccountRef[] {
  const known = new Set(registry.map(a => resolve(a.home)));
  const extras: AccountRef[] = [];
  for (const [agent, dir, prefix, command] of [
    ['claude', '.claude-profiles', 'cc', 'CLAUDE_CONFIG_DIR'], ['codex', '.codex-profiles', 'co', 'CODEX_HOME'],
  ] as const) {
    let names: string[];
    try { names = readdirSync(join(home, dir), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); }
    catch { continue; }
    for (const name of names) {
      const profileHome = join(home, dir, name);
      if (known.has(resolve(profileHome))) continue;
      extras.push({ alias: `${prefix}:${name}`, agent, profile: name, home: profileHome,
        switchCommand: `${command}=~/${dir}/${name} ${agent} ${agent === 'claude' ? '/login' : 'login'}`, registered: false });
    }
  }
  return extras;
}

export function selectAccounts(options: { agent?: Agent | 'both' | 'all'; only?: string[]; all?: boolean; home?: string } = {}): AccountRef[] {
  const home = options.home ?? homedir();
  const registry = registeredAccounts(home);
  let accounts = options.all ? [...registry, ...discoverAccounts(home, registry)] : registry;
  if (options.agent === 'both') accounts = accounts.filter(a => a.agent === 'claude' || a.agent === 'codex');
  else if (options.agent && options.agent !== 'all') accounts = accounts.filter(a => a.agent === options.agent);
  if (options.only?.length) {
    const wanted = options.only.map(name => name.trim().toLowerCase()).filter(Boolean);
    const known = new Set(accounts.map(a => a.alias.toLowerCase()));
    const unknown = wanted.filter(name => !known.has(name));
    if (unknown.length) throw new Error(`Unknown account alias: ${unknown.join(', ')}. Known: ${accounts.map(a => a.alias).join(', ')}.`);
    accounts = accounts.filter(a => wanted.includes(a.alias.toLowerCase()));
  }
  return accounts;
}

/** `admin@example.com` becomes `ad***@example.com`: recognisable, never the full address. */
export function maskIdentity(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value) return null;
  const at = value.indexOf('@');
  if (at < 0) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
}

function claudeIdentity(configDir: string, home = homedir()) {
  const candidates = [join(configDir, '.claude.json')];
  if (resolve(configDir) === resolve(home, '.claude')) candidates.push(join(home, '.claude.json'));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const account = JSON.parse(readFileSync(path, 'utf8')).oauthAccount;
      if (account?.accountUuid) {
        return { hint: maskIdentity(account.emailAddress), organization: account.organizationName ?? null,
          fingerprint: createHash('sha256').update(`${account.accountUuid}:${account.organizationUuid ?? ''}`).digest('hex').slice(0, 12) };
      }
    } catch { /* A damaged profile file is an identity gap, not a quota failure. */ }
  }
  return { hint: null, organization: null, fingerprint: null };
}

/** Separates the windows the table compares without ever merging or adding them. */
export function classifyWindows(windows: QuotaWindow[]) {
  const accountWide = windows.filter(w => !w.modelScope);
  const weekly = accountWide.filter(w => w.window !== 'grok:monthly' && w.windowMinutes >= WEEK_MINUTES).sort((a, b) => a.windowMinutes - b.windowMinutes)[0] ?? null;
  const session = accountWide.filter(w => w.window !== 'grok:monthly' && w.windowMinutes < WEEK_MINUTES).sort((a, b) => a.windowMinutes - b.windowMinutes)[0] ?? null;
  return { weekly, session, scoped: windows.filter(w => w.modelScope) };
}

function unavailable(ref: AccountRef, error: string, hint: string | null): AccountQuota {
  return { ...ref, status: 'unavailable', error, hint, plan: null, identityHint: null, fingerprint: null,
    capturedAt: new Date().toISOString(), weekly: null, session: null, scoped: [], windows: [], extras: null };
}

export async function readAccountQuota(ref: AccountRef, readers: {
  claude?: typeof fetchClaudeQuota; codex?: typeof fetchQuota; grok?: typeof fetchGrokQuota; home?: string;
} = {}): Promise<AccountQuota> {
  const home = readers.home ?? homedir();
  if (!existsSync(ref.home)) {
    return unavailable(ref, `No profile directory at ${ref.home}.`, `Create it by running \`${ref.switchCommand}\` and logging in.`);
  }
  try {
    if (ref.agent === 'grok') {
      const quota = await (readers.grok ?? fetchGrokQuota)(ref.home);
      return { ...ref, status: quota.status, error: quota.status === 'unavailable' ? 'Grok returned no usable quota percentage.' : null,
        hint: null, plan: quota.plan, identityHint: quota.identityHint, fingerprint: quota.accountFingerprint,
        capturedAt: quota.capturedAt, ...classifyWindows(quota.windows), windows: quota.windows, extras: quota.separateCredits };
    }
    if (ref.agent === 'gemini') {
      let fingerprint: string | null = null;
      try {
        const userId = JSON.parse(readFileSync(join(ref.home, '.claude.json'), 'utf8')).userID;
        if (typeof userId === 'string' && userId) {
          fingerprint = createHash('sha256').update(`claude-user:${userId}`).digest('hex').slice(0, 12);
        }
      } catch { /* A missing or damaged profile state file leaves fingerprint null. */ }
      return { ...ref, status: 'unavailable', error: 'Vertex AI is pay-as-you-go; no percentage quota window applies.',
        hint: null, plan: 'pay-as-you-go', identityHint: null, fingerprint,
        capturedAt: new Date().toISOString(), weekly: null, session: null, scoped: [], windows: [], extras: null };
    }
    if (ref.agent === 'claude') {
      const read = readers.claude ?? fetchClaudeQuota;
      // Ignore ambient CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY so each row reads its own profile login.
      const quota = await read(ref.home, { ignoreEnvCredentials: true });
      const identity = claudeIdentity(ref.home, home);
      return { ...ref, status: quota.status === 'observed' ? 'observed' : quota.status === 'partial' ? 'partial' : 'unavailable',
        error: quota.status === 'unavailable' ? 'Claude returned no usable quota window.' : null, hint: null,
        plan: quota.planReportedByCredentials ?? null, identityHint: identity.hint, fingerprint: identity.fingerprint,
        capturedAt: quota.capturedAt, ...classifyWindows(quota.windows), windows: quota.windows,
        extras: quota.separateCredits };
    }
    const read = readers.codex ?? fetchQuota;
    const live = await read(ref.home);
    const windows: QuotaWindow[] = live.windows.map(w => ({ window: w.key, windowMinutes: w.minutes,
      usedPercent: w.used, remainingPercent: 100 - w.used,
      resetsAt: Number.isFinite(w.reset) ? new Date(w.reset).toISOString() : null, modelScope: null, surfaceScope: null }));
    return { ...ref, status: 'observed', error: null, hint: null, plan: live.plan, identityHint: null,
      fingerprint: live.fingerprint, capturedAt: new Date(live.at).toISOString(), ...classifyWindows(windows), windows,
      extras: { buckets: live.extras, resetCount: live.resetCount } };
  } catch (error) {
    const message = error instanceof Error ? error.message : `${ref.alias} quota unavailable.`;
    const stale = /credential|login|auth|expired|token/i.test(message);
    return unavailable(ref, message, stale ? `Run \`${ref.switchCommand}\` in a terminal and finish its login, then rerun.` : null);
  }
}

/** Resolves `range.ts --account cc2` to that profile's agent and home, so a deep report can name an alias instead of a path. */
export function resolveAccountOption(alias: string, home = homedir()) {
  const [ref] = selectAccounts({ only: [alias], all: true, home });
  return { ref, agent: ref.agent, codexHome: ref.agent === 'codex' ? ref.home : null,
    claudeHome: ref.agent === 'claude' ? ref.home : null, grokHome: ref.agent === 'grok' ? ref.home : null,
    geminiHome: ref.agent === 'gemini' ? ref.home : null };
}

/** Names the profile a directory belongs to, so a report reads `cc2 · work` rather than a bare fingerprint; null when no alias or profile directory matches. */
export function accountLabel(agent: Agent, profileHome: string, home = homedir()) {
  const target = resolve(profileHome);
  const ref = selectAccounts({ agent, all: true, home }).find(a => resolve(a.home) === target);
  return ref ? { alias: ref.alias, profile: ref.profile, label: `${ref.alias} · ${ref.profile}`,
    switchCommand: ref.switchCommand, registered: ref.registered } : null;
}

/** Reads every selected account concurrently; one account's failure never discards another's reading. */
export async function readAccountsQuota(refs: AccountRef[], readers: Parameters<typeof readAccountQuota>[1] = {}) {
  return Promise.all(refs.map(ref => readAccountQuota(ref, readers)));
}
