/** Serves quota snapshots and passive conversation speed averages; installed services disable provider probes. */
import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultAccounts, parseAccounts, projectReport, type AccountReport, type Alias } from './report.ts';
import { cacheable, carryForward, loadQuotaCache, mergeScopedWindows, saveQuotaCache } from './quota-cache.ts';
import { superviseSpeed } from './speed-supervisor.ts';
import { emptyHostSnapshot, startHostMonitor, type HostSnapshot } from './host-telemetry.ts';
import { collectOutput, stopCollector } from './bounded-collector.ts';
import { parseRemoteHosts, startRemoteHosts } from './remote-host-streams.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
// The quota reader ships in vendor/remaining-range; TOKEN_RANGE_SCRIPT points at another copy.
const script = process.env.TOKEN_RANGE_SCRIPT ?? resolve(root, 'vendor/remaining-range/range.ts');
const aliases = parseAccounts(process.env.TOKEN_ACCOUNTS ?? defaultAccounts);
const intervalMs = 60_000;
const scopedRefreshMs = 5 * 60_000;
const lastServerAttempt = new Map<Alias, number>();
const port = Number(process.env.TOKEN_PORT ?? 8047);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid TOKEN_PORT.');
let running = false;
let generation = 0;
let startedAt: string | null = null;
let completedAt: string | null = null;
let nextRefreshAt = Date.now();
let accounts: AccountReport[] = [];
// Last provider reading per account, kept on disk so a restart inside a cycle still has it.
const cachePath = process.env.TOKEN_QUOTA_CACHE ?? resolve(homedir(), '.local/share/token-dashboard/state/last-quota.json');
const quotaCache = await loadQuotaCache(cachePath);
const children = new Set<ChildProcess>();
let speed: any = { samples: [], nextFallbackAt: null, fallbackEnabled: false, observedAt: null, fallbackIntervalMs: 3600_000 };
const stopSpeed = superviseSpeed(process.execPath,
  ['--disable-warning=ExperimentalWarning', resolve(root, 'dist/speed-worker.js'), script, aliases.join(',')],
  reading => { speed = reading; }, () => { speed.observedAt = null; },
  { log: message => process.stderr.write(`${new Date().toISOString()} ${message}\n`) });
let host: HostSnapshot = emptyHostSnapshot();
const stopHost = startHostMonitor(reading => { host = reading; });
const remotes = startRemoteHosts(parseRemoteHosts(process.env.TOKEN_REMOTE_HOSTS),
  message => process.stderr.write(`${new Date().toISOString()} ${message}\n`));

function needsServerQuota(alias: Alias, cached: AccountReport | undefined, now = Date.now()) {
  if (!alias.startsWith('cc') || now - (lastServerAttempt.get(alias) ?? 0) < scopedRefreshMs) return false;
  const fable = cached?.windows.find(row => row.scoped && row.model?.toLowerCase().includes('fable'));
  const observed = fable?.observedAt ? Date.parse(fable.observedAt) : Number.NaN;
  return !Number.isFinite(observed) || now - observed >= scopedRefreshMs;
}

async function collectAccount(alias: Alias, preferServer = false): Promise<AccountReport> {
  const env = { ...process.env };
  for (const key of ['CODEX_THREAD_ID', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) delete env[key];
  if (preferServer) lastServerAttempt.set(alias, Date.now());
  try {
    const stdout = await collectOutput(process.execPath,
      ['--disable-warning=ExperimentalWarning', resolve(root, 'collect.ts'), '--range-script', script, '--account', alias,
        ...(preferServer ? ['--prefer-server'] : [])],
      { env, onStart: child => children.add(child), onDone: child => children.delete(child) });
    return projectReport(alias, JSON.parse(stdout));
  } catch {
    return projectReport(alias, { capturedAt: new Date().toISOString(), error: 'Quota read failed' });
  }
}

async function refresh() {
  if (running) return;
  running = true;
  const now = Date.now();
  startedAt = new Date(now).toISOString();
  nextRefreshAt = now + intervalMs;
  const raw = await Promise.all(aliases.map(alias => collectAccount(alias, needsServerQuota(alias, quotaCache.get(alias), now))));
  const fresh = raw.map(report => mergeScopedWindows(report, quotaCache.get(report.alias), now));
  for (const report of fresh) if (cacheable(report)) quotaCache.set(report.alias, report);
  accounts = fresh.map(report => carryForward(report, quotaCache.get(report.alias), now));
  await saveQuotaCache(cachePath, quotaCache).catch(() => { /* The in-memory cache still serves this process. */ });
  completedAt = new Date().toISOString();
  generation++;
  running = false;
}

const files: Record<string, [string, string]> = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['web/dist/app.js', 'application/javascript; charset=utf-8'],
  '/logos/claude.svg': ['web/logos/claude.svg', 'image/svg+xml'],
  '/logos/openai.svg': ['web/logos/openai.svg', 'image/svg+xml'],
  '/logos/grok.svg': ['web/logos/grok.svg', 'image/svg+xml'],
  '/logos/gemini.svg': ['web/logos/gemini.svg', 'image/svg+xml'],
};
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path === '/health' || path === '/api/usage' || path === '/api/speed' || path === '/api/host' || path === '/api/hosts') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(path === '/api/speed' ? { ...speed,
      stale: speed.observedAt === null || Date.now() - Date.parse(speed.observedAt) > 20_000 }
      : path === '/api/host' ? { ...host,
        stale: host.observedAt === null || Date.now() - Date.parse(host.observedAt) > 10_000 }
      : path === '/api/hosts' ? { hosts: remotes.read() }
      : path === '/health' ? { status: 'ok', generation, running, completedAt }
      : { generation, running, startedAt, completedAt, nextRefreshAt, intervalMs, accounts,
        stale: completedAt === null || Date.now() - Date.parse(completedAt) > intervalMs * 2 }));
    return;
  }
  const file = files[path];
  if (!file) { response.writeHead(404).end('Not found'); return; }
  try { response.setHeader('Content-Type', file[1]); response.end(await readFile(resolve(root, file[0]))); }
  catch { response.writeHead(503).end('Asset unavailable'); }
});
server.listen(port, process.env.TOKEN_HOST ?? '127.0.0.1', () => {
  process.stdout.write(`Token Arcade listening on port ${port}\n`);
  void refresh();
});
const timer = setInterval(() => void refresh(), intervalMs);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  clearInterval(timer);
  stopSpeed();
  stopHost();
  remotes.stop();
  for (const child of children) stopCollector(child, 'SIGKILL');
  server.close(() => process.exit(0));
});
