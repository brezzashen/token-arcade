import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { accountLabel, classifyWindows, discoverAccounts, maskIdentity, readAccountQuota, readAccountsQuota, registeredAccounts, resolveAccountOption, selectAccounts } from './account-registry.ts';
import type { AccountRef, QuotaWindow } from './account-registry.ts';
import { GROK_BILLING_URL, fetchGrokQuota, normalizeGrokQuota } from './grok-quota.ts';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const at = Date.parse('2026-10-05T08:00:00Z');

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'accounts-'));
  for (const dir of ['.claude', '.claude-profiles/p1', '.claude-profiles/p2', '.claude-profiles/p3', '.claude-profiles/p4', '.claude-profiles/stray', '.codex', '.codex-profiles/work', '.grok', '.config/cg4/claude-home']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-admin',
    organizationUuid: 'org', emailAddress: 'admin@example.com', organizationName: 'Example' } }));
  writeFileSync(join(home, '.config/cg4/claude-home/.claude.json'), JSON.stringify({ userID: 'cg4-user-id' }));
  return { home, close: () => rmSync(home, { recursive: true, force: true }) };
}

const window = (overrides: Partial<QuotaWindow>): QuotaWindow => ({ window: 'w', windowMinutes: 10080, usedPercent: 10,
  remainingPercent: 90, resetsAt: new Date(at + 3600_000).toISOString(), modelScope: null, surfaceScope: null, ...overrides });

const claudeQuota = (percent: number) => async () => ({ status: 'observed' as const, capturedAt: new Date(at).toISOString(),
  source: 'test', invalidWindows: 0, separateCredits: null, limitations: [], planReportedByCredentials: 'team',
  windows: [window({ window: 'claude:session:0', windowMinutes: 300, usedPercent: 40, remainingPercent: 60 }),
    window({ window: 'claude:weekly_all:1', usedPercent: percent, remainingPercent: 100 - percent }),
    window({ window: 'claude:weekly_scoped:2', usedPercent: 5, remainingPercent: 95, modelScope: { id: null, label: 'Fable' } })] });

const grokBilling = { config: { creditUsagePercent: 3, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY',
  start: '2026-10-05T21:58:37Z', end: '2026-10-12T21:58:37Z' }, prepaidBalance: { val: 0 },
  productUsage: [{ product: 'PRODUCT_GROK_BUILD', usagePercent: 61.2 }] } };

test('aliases map to the registered profiles, including Grok, while both preserves the original providers', () => {
  const f = fixture();
  try {
    const registry = registeredAccounts(f.home);
    assert.deepEqual(registry.map(a => a.alias), ['cc1', 'cc2', 'cc3', 'cc4', 'cc5', 'co1', 'co2', 'grok', 'gm']);
    assert.deepEqual(registry.map(a => a.home), [join(f.home, '.claude'), join(f.home, '.claude-profiles/p1'),
      join(f.home, '.claude-profiles/p2'), join(f.home, '.claude-profiles/p3'), join(f.home, '.claude-profiles/p4'), join(f.home, '.codex'), join(f.home, '.codex-profiles/work'), join(f.home, '.grok'), join(f.home, '.config/cg4/claude-home')]);
    assert.deepEqual(registry.map(a => a.switchCommand), ['claude /login', 'CLAUDE_CONFIG_DIR=~/.claude-profiles/p1 claude /login', 'CLAUDE_CONFIG_DIR=~/.claude-profiles/p2 claude /login', 'CLAUDE_CONFIG_DIR=~/.claude-profiles/p3 claude /login', 'CLAUDE_CONFIG_DIR=~/.claude-profiles/p4 claude /login', 'codex login', 'CODEX_HOME=~/.codex-profiles/work codex login', 'grok login', 'cg4']);
    assert.deepEqual(selectAccounts({ agent: 'both', home: f.home }).map(a => a.alias), ['cc1', 'cc2', 'cc3', 'cc4', 'cc5', 'co1', 'co2']);
    assert.deepEqual(selectAccounts({ agent: 'grok', home: f.home }).map(a => a.alias), ['grok']);
    assert.deepEqual(selectAccounts({ agent: 'gemini', home: f.home }).map(a => a.alias), ['gm']);
    assert.deepEqual(selectAccounts({ agent: 'codex', home: f.home }).map(a => a.alias), ['co1', 'co2']);
    assert.deepEqual(selectAccounts({ only: ['CO2', 'cc1'], home: f.home }).map(a => a.alias), ['cc1', 'co2']);
    assert.throws(() => selectAccounts({ only: ['cc9'], home: f.home }), /Unknown account alias: cc9/);
    assert.deepEqual(discoverAccounts(f.home).map(a => a.alias), ['cc:stray']);
    assert.ok(!selectAccounts({ home: f.home }).some(a => a.profile === 'stray'));
    const stray = selectAccounts({ all: true, home: f.home }).find(a => a.profile === 'stray')!;
    assert.equal(stray.registered, false);
    assert.equal(stray.switchCommand, 'CLAUDE_CONFIG_DIR=~/.claude-profiles/stray claude /login');
    assert.deepEqual(accountLabel('claude', join(f.home, '.claude-profiles/p2'), f.home),
      { alias: 'cc3', profile: 'p2', label: 'cc3 · p2', switchCommand: 'CLAUDE_CONFIG_DIR=~/.claude-profiles/p2 claude /login', registered: true });
    assert.equal(accountLabel('codex', join(f.home, '.claude'), f.home), null);
    assert.equal(accountLabel('claude', join(f.home, 'elsewhere'), f.home), null);
    assert.equal(accountLabel('claude', join(f.home, '.claude-profiles/stray'), f.home)!.label, 'cc:stray · stray');
    assert.equal(maskIdentity('admin@example.com'), 'ad***@example.com');
    assert.equal(maskIdentity(null), null);
  } finally { f.close(); }
});

test('windows stay separated by scope and duration, and are never merged into one figure', () => {
  const session = window({ window: 's', windowMinutes: 300, usedPercent: 40, remainingPercent: 60 });
  const weekly = window({ window: 'w7', usedPercent: 47, remainingPercent: 53 });
  const scoped = window({ window: 'fable', usedPercent: 5, remainingPercent: 95, modelScope: { id: null, label: 'Fable' } });
  const classified = classifyWindows([scoped, weekly, session]);
  assert.equal(classified.weekly!.window, 'w7');
  assert.equal(classified.session!.window, 's');
  assert.deepEqual(classified.scoped.map(w => w.window), ['fable']);
  const noWeekly = classifyWindows([session]);
  assert.equal(noWeekly.weekly, null);
  assert.equal(classifyWindows([]).session, null);
});

test('each account is read with its own login, and one failure never discards the others', async () => {
  const f = fixture();
  try {
    const refs = selectAccounts({ home: f.home });
    const seen: Array<{ dir: string; ignoreEnv: boolean | undefined }> = [];
    const accounts = await readAccountsQuota(refs, { home: f.home,
      claude: (async (dir: string, options: { ignoreEnvCredentials?: boolean } = {}) => {
        seen.push({ dir, ignoreEnv: options.ignoreEnvCredentials });
        if (dir.endsWith('/p2')) throw new Error('No unexpired OAuth credentials in this Claude profile; refresh its Claude CLI login.');
        return claudeQuota(dir.endsWith('.claude') ? 47 : 2)();
      }) as never,
      codex: (async (home: string) => ({ at, accountId: `id-${home}`, fingerprint: 'abcdef123456', plan: 'promax',
        windows: [{ key: 'codex:primary', bucket: 'codex', slot: 'primary', used: 98, minutes: 10080, reset: at + 7200_000 }],
        extras: [], resetCount: 2 })) as never,
      grok: (async (dir: string) => {
        assert.equal(dir, join(f.home, '.grok'));
        return { ...normalizeGrokQuota(grokBilling, at), identityHint: 'gr***@example.com', accountFingerprint: 'grok-fingerprint' };
      }) as never });
    assert.deepEqual(seen.map(s => s.ignoreEnv), [true, true, true, true, true]);
    assert.deepEqual(accounts.map(a => a.status), ['observed', 'observed', 'unavailable', 'observed', 'observed', 'observed', 'observed', 'observed', 'unavailable']);
    assert.deepEqual(accounts.map(a => a.weekly?.remainingPercent ?? null), [53, 98, null, 98, 98, 2, 2, 97, null]);
    assert.equal(accounts[8].plan, 'pay-as-you-go');
    assert.ok(accounts[8].fingerprint && !accounts[8].fingerprint.includes('cg4-user-id'));
    assert.equal(accounts[0].identityHint, 'ad***@example.com');
    assert.equal(accounts[1].identityHint, null);
    assert.equal(accounts[0].session!.remainingPercent, 60);
    assert.deepEqual(accounts[0].scoped.map(w => w.modelScope?.label), ['Fable']);
    assert.equal(accounts[5].session, null);
    assert.match(accounts[2].hint!, /CLAUDE_CONFIG_DIR=~\/\.claude-profiles\/p2/);
    assert.ok(!JSON.stringify(accounts).includes('admin@example.com'));
    const missing = await readAccountQuota({ ...refs[0], home: join(f.home, 'absent') } as AccountRef, { home: f.home });
    assert.equal(missing.status, 'unavailable');
    assert.match(missing.error!, /No profile directory/);
  } finally { f.close(); }
});

test('the accounts CLI plans without quota RPC, selects by alias and writes nothing', () => {
  const f = fixture();
  try {
    const snapshot = () => readdirSync(f.home, { recursive: true }).map(p => `${p}:${statSync(join(f.home, String(p))).mtimeMs}`).sort();
    const before = snapshot();
    const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'accounts.ts'),
      '--home', f.home, ...args], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent',
      CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } });
    const plan = run('--dry-run');
    assert.equal(plan.status, 0, plan.stderr);
    const parsed = JSON.parse(plan.stdout);
    assert.deepEqual(parsed.accounts.map((a: AccountRef) => a.alias), ['cc1', 'cc2', 'cc3', 'cc4', 'cc5', 'co1', 'co2', 'grok', 'gm']);
    assert.deepEqual(JSON.parse(run('--dry-run', '--agent', 'both').stdout).accounts.map((a: AccountRef) => a.alias),
      ['cc1', 'cc2', 'cc3', 'cc4', 'cc5', 'co1', 'co2']);
    assert.deepEqual(JSON.parse(run('--dry-run', '--agent', 'gemini').stdout).accounts.map((a: AccountRef) => a.alias), ['gm']);
    const scoped = JSON.parse(run('--dry-run', '--only', 'co1', '--agent', 'codex').stdout);
    assert.deepEqual(scoped.accounts.map((a: AccountRef) => a.alias), ['co1']);
    const bad = run('--dry-run', '--agent', 'invalid');
    assert.equal(bad.status, 1);
    assert.match(JSON.parse(bad.stderr).error, /agent must be codex, claude, both, grok, gemini or all/);
    assert.deepEqual(snapshot(), before);
  } finally { f.close(); }
});

test('an alias selects one deep range report without mixing two profile directories', () => {
  const f = fixture();
  try {
    const claude = resolveAccountOption('cc2', f.home);
    assert.equal(claude.agent, 'claude');
    assert.equal(claude.claudeHome, join(f.home, '.claude-profiles/p1'));
    assert.equal(claude.codexHome, null);
    const codex = resolveAccountOption('CO1', f.home);
    assert.equal(codex.agent, 'codex');
    assert.equal(codex.codexHome, join(f.home, '.codex'));
    assert.equal(resolveAccountOption('grok', f.home).grokHome, join(f.home, '.grok'));
    assert.equal(resolveAccountOption('gm', f.home).geminiHome, join(f.home, '.config/cg4/claude-home'));
    assert.throws(() => resolveAccountOption('cc9', f.home), /Unknown account alias/);
    const conflict = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'range.ts'),
      '--account', 'cc1', '--claude-home', f.home], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });
    assert.equal(conflict.status, 1);
    assert.match(JSON.parse(conflict.stderr).error, /--account already selects a profile directory/);
  } finally { f.close(); }
});

test('Grok separates weekly and monthly allowance, ignores product shares and preserves missing versus zero counters', () => {
  const quota = normalizeGrokQuota(grokBilling, at);
  assert.equal(quota.usedPercent, 3);
  assert.equal(quota.remainingPercent, 97);
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0].windowMinutes, 10080);
  assert.equal(quota.windows[0].modelScope, null);
  assert.equal(quota.separateCredits.prepaidBalanceCents, 0);
  assert.equal(quota.separateCredits.onDemandUsedCents, null);
  assert.equal(normalizeGrokQuota({ config: { ...grokBilling.config, creditUsagePercent: 0 } }).remainingPercent, 100);
  assert.equal(normalizeGrokQuota({ config: { ...grokBilling.config, creditUsagePercent: 100 } }).remainingPercent, 0);
  for (const bad of [undefined, null, -1, 101, '3', NaN, Infinity]) {
    const unavailable = normalizeGrokQuota({ config: { ...grokBilling.config, creditUsagePercent: bad } });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.remainingPercent, null);
    assert.deepEqual(unavailable.windows, []);
  }
  assert.equal(normalizeGrokQuota({ config: null }).status, 'unavailable');
  const monthly = normalizeGrokQuota({ config: { monthlyLimit: { val: '2000' }, used: { val: '500' },
    billingPeriodStart: '2026-10-01T00:00:00Z', billingPeriodEnd: '2026-11-01T00:00:00Z' } });
  assert.equal(monthly.usedPercent, 25);
  assert.equal(monthly.windows[0].window, 'grok:monthly');
  assert.equal(classifyWindows(monthly.windows).weekly, null);
  assert.equal(classifyWindows(monthly.windows).session, null);
  const unknown = normalizeGrokQuota({ config: { creditUsagePercent: 3 } });
  assert.equal(unknown.status, 'partial');
  assert.equal(unknown.remainingPercent, 97);
  assert.deepEqual(unknown.windows, []);
});

test('Grok reads only selected-profile credentials and never retries, redirects, writes or exposes private error bodies', async () => {
  const f = fixture();
  const dir = join(f.home, '.grok'), authPath = join(dir, 'auth.json');
  const auth = { key: 'private-token', user_id: 'private-user-id', email: 'grok@example.com', expires_at: '2099-01-01T00:00:00Z' };
  const stored = JSON.stringify({ 'https://auth.x.ai::client': auth });
  writeFileSync(authPath, stored);
  const before = statSync(authPath).mtimeMs;
  let calls = 0;
  const request = (async (url: string, options: RequestInit) => {
    calls++;
    assert.equal(url, GROK_BILLING_URL);
    assert.equal(options.redirect, 'error');
    assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer private-token');
    assert.equal((options.headers as Record<string, string>)['x-userid'], 'private-user-id');
    return new Response(JSON.stringify(grokBilling));
  }) as typeof fetch;
  try {
    const quota = await fetchGrokQuota(dir, request);
    assert.equal(calls, 1);
    assert.equal(quota.identityHint, 'gr***@example.com');
    assert.ok(!/private-token|private-user-id|grok@example.com/.test(JSON.stringify(quota)));
    assert.equal(statSync(authPath).size, Buffer.byteLength(stored));
    assert.equal(readFileSync(authPath, 'utf8'), stored);
    assert.equal(statSync(authPath).mtimeMs, before);
    const rateLimited = (async () => { calls++; return new Response('private-token private-user-id', { status: 429 }); }) as typeof fetch;
    await assert.rejects(fetchGrokQuota(dir, rateLimited), /Grok billing HTTP 429; do not poll or retry immediately/);
    assert.equal(calls, 2);
    writeFileSync(authPath, JSON.stringify({ 'https://auth.x.ai::client': { ...auth, expires_at: '2020-01-01T00:00:00Z' } }));
    await assert.rejects(fetchGrokQuota(dir, request), /Grok OAuth login expired/);
    assert.equal(calls, 2);
    writeFileSync(authPath, JSON.stringify({ 'https://external.example::client': auth }));
    await assert.rejects(fetchGrokQuota(dir, request), /No first-party Grok subscription login/);
    assert.equal(calls, 2);
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'range.ts'),
      '--agent', 'grok', '--grok-home', dir], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.agent, 'grok');
    assert.equal(report.quota.status, 'unavailable');
    assert.equal(report.tokens.status, 'unavailable');
    assert.equal(report.dashboard.remainingMinutes, null);
  } finally { f.close(); }
});

test('all range mode isolates three unavailable providers and both retains two reports without model calls', () => {
  const f = fixture();
  try {
    const run = (agent: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(scripts, 'range.ts'),
      '--agent', agent, '--home', join(f.home, '.codex'), '--claude-home', join(f.home, '.claude'),
      '--grok-home', join(f.home, '.grok')], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: '/nonexistent', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } });
    const all = run('all');
    assert.equal(all.status, 0, all.stderr);
    const report = JSON.parse(all.stdout);
    assert.deepEqual(Object.keys(report.agents), ['codex', 'claude', 'grok', 'gemini']);
    assert.equal(report.agents.codex.status, 'unavailable');
    assert.equal(report.agents.claude.quota.status, 'unavailable');
    assert.equal(report.agents.grok.quota.status, 'unavailable');
    assert.equal(report.agents.gemini.quota.status, 'unavailable');
    assert.equal(report.agents.gemini.quota.plan, 'pay-as-you-go');
    const both = run('both');
    assert.equal(both.status, 0, both.stderr);
    assert.deepEqual(Object.keys(JSON.parse(both.stdout).agents), ['codex', 'claude']);
  } finally { f.close(); }
});
