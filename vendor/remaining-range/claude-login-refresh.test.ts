import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFRESH_INTERVAL_MS, refreshClaudeLogin } from './claude-login-refresh.ts';
import { CLAUDE_USAGE_URL, fetchClaudeQuota } from './claude-quota.ts';

test('An expired profile login is renewed once by the Claude CLI, then the read uses the renewed token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-refresh-'));
  const originalFetch = globalThis.fetch;
  const credentials = (expiresAt: number, accessToken: string) => writeFileSync(join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, subscriptionType: 'team' } }));
  let refreshes = 0;
  try {
    credentials(Date.now() - 60_000, 'expired');
    globalThis.fetch = async (input, options) => {
      assert.equal(input, CLAUDE_USAGE_URL);
      assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer renewed');
      return new Response(JSON.stringify({ seven_day: { utilization: 12, resets_at: new Date(Date.now() + 86400_000).toISOString() } }));
    };
    const quota = await fetchClaudeQuota(dir, { ignoreEnvCredentials: true,
      refreshExpiredLogin: () => { refreshes++; credentials(Date.now() + 3600_000, 'renewed'); return true; } });
    assert.equal(refreshes, 1);
    assert.equal(quota.planReportedByCredentials, 'team');
    credentials(Date.now() - 60_000, 'expired');
    await assert.rejects(fetchClaudeQuota(dir, { ignoreEnvCredentials: true, refreshExpiredLogin: () => false }),
      /No unexpired OAuth credentials/);
    await assert.rejects(fetchClaudeQuota(dir, { ignoreEnvCredentials: true }), /No unexpired OAuth credentials/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Refresh runs are isolated from ambient auth and throttled per profile', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'claude-refresh-state-'));
  const home = '/fixture-home';
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run = (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => { calls.push({ file, args, env: options.env }); };
  const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ambient-token';
  try {
    const now = Date.now();
    assert.equal(refreshClaudeLogin('/fixture-home/.claude-profiles/team5', { now, stateDir, home, run }), true);
    assert.equal(calls[0].file, '/fixture-home/.local/bin/claude');
    assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, '/fixture-home/.claude-profiles/team5');
    assert.equal(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.ok(calls[0].args.includes('--no-session-persistence') && calls[0].args.includes('--strict-mcp-config'));
    assert.equal(refreshClaudeLogin('/fixture-home/.claude-profiles/team5', { now: now + 60_000, stateDir, home, run }), false);
    assert.equal(calls.length, 1);
    assert.equal(refreshClaudeLogin('/fixture-home/.claude-profiles/team5',
      { now: now + REFRESH_INTERVAL_MS + 1, stateDir, home, run }), true);
    assert.equal(refreshClaudeLogin('/fixture-home/.claude', { now, stateDir, home, run }), true);
    assert.equal(calls.at(-1)!.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(refreshClaudeLogin('/fixture-home/.claude-profiles/team4', { now, stateDir, home,
      run: () => { throw new Error('logged out'); } }), false);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
