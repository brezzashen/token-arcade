/** Query the official read-only slash command, without starting a model turn. */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { geminiPlan } from './subscription.ts';

const exec = promisify(execFile);
export const ANTIGRAVITY_QUOTA_TTL_MS = 15 * 60_000;
const LOG_RETENTION_MS = 24 * 3600_000;

export function parseAntigravityQuota(value: any, now = Date.now()) {
  if (value?.status !== 'SUCCESS' || value.num_turns !== 0 || value.command?.name !== 'usage'
    || !Array.isArray(value.command.data?.groups)) throw new Error('Invalid Antigravity quota response.');
  const windows: any[] = [];
  for (const group of value.command.data.groups) {
    if (typeof group.name !== 'string' || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      const minutes = bucket.window === 'weekly' ? 10080 : bucket.window === '5h' ? 300 : null;
      const fraction = bucket.remaining_fraction;
      const reset = Date.parse(bucket.reset_time);
      if (minutes === null || typeof fraction !== 'number' || !Number.isFinite(fraction)
        || fraction < 0 || fraction > 1 || !Number.isFinite(reset) || reset <= now) continue;
      windows.push({ window: bucket.id, windowMinutes: minutes, remainingPercent: fraction * 100,
        usedPercent: (1 - fraction) * 100, resetsAt: new Date(reset).toISOString(),
        modelScope: group.name === 'Gemini Models' ? null : { label: group.name }, surfaceScope: null });
    }
  }
  if (!windows.length) throw new Error('No valid Antigravity quota windows.');
  return { status: 'observed', plan: geminiPlan, windows, capturedAt: new Date(now).toISOString() };
}

async function readCachedQuota(cachePath: string, now: number, ttlMs: number) {
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    const capturedAt = Date.parse(cached?.capturedAt);
    if (cached?.status !== 'observed' || !Array.isArray(cached.windows) || !cached.windows.length
      || !Number.isFinite(capturedAt) || now - capturedAt < 0 || now - capturedAt >= ttlMs) return null;
    const allLive = cached.windows.every((w: any) => {
      const reset = Date.parse(w?.resetsAt);
      return Number.isFinite(reset) && reset > now;
    });
    return allLive ? cached : null;
  } catch { return null; }
}

async function writeCachedQuota(cachePath: string, reading: any) {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(reading));
    await rename(tmp, cachePath);
  } catch { /* Best-effort cache write. */ }
}

async function pruneCliLogs(logDir: string, now: number) {
  try {
    for (const name of await readdir(logDir)) {
      if (!name.startsWith('cli-') || !name.endsWith('.log')) continue;
      const filePath = join(logDir, name);
      try {
        const info = await stat(filePath);
        if (info.size === 0 || now - info.mtimeMs > LOG_RETENTION_MS) await rm(filePath, { force: true });
      } catch { /* Ignore concurrent deletion. */ }
    }
  } catch { /* Ignore missing log directory. */ }
}

export async function readAntigravityQuota(home = homedir(), now = Date.now(), ttlMs = ANTIGRAVITY_QUOTA_TTL_MS) {
  const cliDir = join(home, '.gemini/antigravity-cli');
  const cachePath = join(cliDir, 'quota-cache.json');
  const cached = await readCachedQuota(cachePath, now, ttlMs);
  if (cached) return cached;
  try {
    const env = { ...process.env, HOME: home };
    for (const key of ['GOOGLE_GENAI_USE_VERTEXAI', 'AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) delete env[key];
    const { stdout } = await exec(join(home, '.local/bin/agy'),
      ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env });
    const parsed = parseAntigravityQuota(JSON.parse(stdout), now);
    await Promise.all([writeCachedQuota(cachePath, parsed), pruneCliLogs(join(cliDir, 'log'), now)]);
    return parsed;
  } catch {
    return { status: 'unavailable', plan: geminiPlan, windows: [], error: 'Antigravity quota unavailable.',
      capturedAt: new Date(now).toISOString() };
  }
}
