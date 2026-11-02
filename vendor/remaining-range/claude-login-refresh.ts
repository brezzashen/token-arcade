/** Lets the Claude CLI renew an idle profile's expired OAuth login. The CLI refreshes the access token only when it runs, so a
profile nobody used for hours keeps an expired token and every quota read fails as a login problem. One minimal Haiku print run
(no user settings, hooks, tools, MCP or session file) makes the CLI refresh and write the token back to that profile's Keychain
entry itself; this module never touches the rotating refresh token, so it cannot race a live session. Attempts are throttled per
profile through a marker file, so a real logout costs one run per REFRESH_INTERVAL_MS. claude-login-refresh.test.ts covers renewal and the throttle. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const REFRESH_INTERVAL_MS = 30 * 60_000;
/** The quota collector kills the whole read after 40 s; a refresh run normally takes about 10 s. */
const REFRESH_TIMEOUT_MS = 20_000;

export type RefreshOptions = { now?: number; stateDir?: string; claudeBin?: string; home?: string;
  run?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => void };

const defaultRun: NonNullable<RefreshOptions['run']> = (file, args, options) => {
  execFileSync(file, args, { ...options, stdio: ['ignore', 'ignore', 'ignore'], killSignal: 'SIGTERM' });
};

/** Returns true when a refresh run finished, so the caller re-reads the stored credentials once. */
export function refreshClaudeLogin(configDir: string, options: RefreshOptions = {}): boolean {
  const now = options.now ?? Date.now();
  const home = options.home ?? homedir();
  const stateDir = options.stateDir ?? join(tmpdir(), 'remaining-range-claude-refresh');
  const path = resolve(configDir);
  const marker = join(stateDir, createHash('sha256').update(path).digest('hex').slice(0, 16));
  try { if (now - statSync(marker).mtimeMs < REFRESH_INTERVAL_MS) return false; }
  catch { /* No earlier attempt for this profile. */ }
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(marker, '');
    utimesSync(marker, now / 1000, now / 1000);
  } catch { return false; }
  // The default profile keeps its unsuffixed Keychain entry only without CLAUDE_CONFIG_DIR (see claudeKeychainService).
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']) delete env[key];
  if (path !== resolve(home, '.claude')) env.CLAUDE_CONFIG_DIR = path;
  try {
    (options.run ?? defaultRun)(options.claudeBin ?? join(home, '.local/bin/claude'),
      ['-p', 'reply with exactly: ok', '--model', 'haiku', '--no-session-persistence', '--setting-sources', '',
        '--strict-mcp-config', '--tools', '', '--disable-slash-commands'],
      { cwd: tmpdir(), env, timeout: REFRESH_TIMEOUT_MS });
    return true;
  } catch { return false; }
}
