/** Reuse installed skill readers for rolling telemetry without another provider query. */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Alias } from './report.ts';

type Report = Record<string, any>;
type Builder = (records: any, start: number, end: number) => Report;
const dayMs = 24 * 3600_000;

export function buildRollingTelemetry(records: any, end: number, tokenBuilder: Builder, cacheBuilder: Builder) {
  const start = end - dayMs;
  const rolling = (report: Report) => ({ ...report,
    scope: 'Locally recorded profile responses during the last 24 hours, including owned subagents.',
    samples: report.samples.map((row: Report) => ({ ...row, id: row.id === 'today' ? 'last_24_hours' : row.id })),
  });
  return { tokens: rolling(tokenBuilder(records, start, end)), cache: rolling(cacheBuilder(records, start, end)) };
}

export function unavailableTelemetry(end: number) {
  return { tokens: { samples: [1, 3, 5, 24].map((hours, index) => ({
    id: ['last_hour', 'last_three_hours', 'last_five_hours', 'last_24_hours'][index],
    start: new Date(end - hours * 3600_000).toISOString(), end: new Date(end).toISOString(), status: 'unavailable',
  })), byModel: [] }, cache: { samples: [] } };
}

export async function readRollingTelemetry(rangeScript: string, alias: Alias, report: Report) {
  if (alias === 'grok') return { tokens: report.tokens, cache: report.cache };
  const end = Date.parse(report.capturedAt);
  if (!Number.isFinite(end)) throw new Error('Missing capture time.');
  const module = (name: string) => import(pathToFileURL(resolve(dirname(rangeScript), `${name}.ts`)).href);
  const registry = await module('account-registry');
  const profile = registry.resolveAccountOption(alias);
  const isCodex = profile.agent === 'codex';
  const home = isCodex ? profile.codexHome : profile.claudeHome ?? profile.geminiHome;
  if (!home) throw new Error('Unsupported profile.');
  const identityModule = await module(isCodex ? 'quota' : 'claude-records');
  const readIdentity: (home: string) => string = isCodex ? identityModule.readAccountId
    : profile.agent === 'gemini' ? identityModule.readGeminiProfileId : identityModule.readClaudeAccountId;
  let identity: string | null = null;
  try { identity = readIdentity(home); }
  catch (error) { if (isCodex || report.accountFingerprint) throw error; }
  if (report.accountFingerprint && (identity === null
    || createHash('sha256').update(identity).digest('hex').slice(0, 12) !== report.accountFingerprint)) {
    throw new Error('Profile identity changed after quota collection.');
  }
  const reader = await module(isCodex ? 'records' : 'claude-usage-records');
  const records = isCodex ? await reader.readRecords(home, identity, end - dayMs, end)
    : await reader.readClaudeUsageRecords(home, end - dayMs, end);
  if (identity !== null && readIdentity(home) !== identity) throw new Error('Profile identity changed during telemetry collection.');
  const tokenModule = await module('token-report');
  const cacheModule = await module('cache-report');
  return buildRollingTelemetry(records, end, tokenModule.buildTokenReport, cacheModule.buildCacheReport);
}
