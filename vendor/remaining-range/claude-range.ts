/** Builds a passive Claude quota/token report for range.ts from current-profile OAuth and all local response transcripts. A quota failure preserves token data; no historical percentage delta or model budget is invented. Every window with a reset time also carries `cycleTokens`, the cumulative consumption since that window last reset (resetsAt minus its duration, to capture), because its used percentage is then a measured delta from zero; a model-scoped window counts only matching model IDs. claude-records.test.ts exercises local coverage, the cycle intervals and failure independence. */
import { createHash } from 'node:crypto';
import { readClaudeAccountId } from './claude-records.ts';
import { fetchClaudeQuota } from './claude-quota.ts';
import { readClaudeUsageRecords } from './claude-usage-records.ts';
import { dayStart } from './records.ts';
import { buildTokenReport, cycleTokenConsumption } from './token-report.ts';
import { buildCacheReport } from './cache-report.ts';

export async function buildClaudeRange(configDir: string, timezone: string,
  quotaReader = fetchClaudeQuota, now = Date.now()) {
  let identity: string | null = null;
  try { if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) identity = readClaudeAccountId(configDir); }
  catch { /* Local tokens remain readable without a current login. */ }
  let quota: Awaited<ReturnType<typeof fetchClaudeQuota>> | { status: 'unavailable'; error: string };
  try { quota = await quotaReader(configDir); }
  catch (error) { quota = { status: 'unavailable', error: error instanceof Error ? error.message : 'Claude quota unavailable.' }; }
  const end = 'capturedAt' in quota ? Date.parse(quota.capturedAt) : now;
  const start = dayStart(end, timezone);
  const cycleStarts = 'windows' in quota ? quota.windows.filter(w => w.resetsAt !== null)
    .map(w => Math.min(end, Date.parse(w.resetsAt!) - w.windowMinutes * 60_000)) : [];
  const records = await readClaudeUsageRecords(configDir, Math.min(start, ...cycleStarts), end);
  if (identity !== null && readClaudeAccountId(configDir) !== identity) throw new Error('Claude profile account changed during query; rerun.');
  const tokens = { ...buildTokenReport(records, start, end),
    basis: 'Deduplicated Claude assistant message usage; input = plain input + cache read + cache creation; total = input + output.',
    scope: 'All locally recorded Claude responses in this profile today, including headless runs and subagents.',
    ownershipBasis: 'Local profile transcripts have no per-record account identity and may predate a login switch; environment-token identity is unverified.',
  };
  return { title: 'Claude Remaining Range', agent: 'claude', capturedAt: new Date(end).toISOString(), timezone,
    status: quota.status !== 'observed' || tokens.samples.at(-1)!.status !== 'observed' ? 'partial' : 'observed',
    accountFingerprint: identity ? createHash('sha256').update(identity).digest('hex').slice(0, 12) : null,
    quota: 'windows' in quota ? { ...quota, windows: quota.windows.map(w => {
      // A surface-scoped or unlabeled model-scoped window cannot be matched to local records.
      const label = w.modelScope?.label?.toLowerCase();
      if (w.resetsAt === null || w.surfaceScope !== null || (w.modelScope && !label)) return { ...w, cycleTokens: null };
      return { ...w, cycleTokens: cycleTokenConsumption(records,
        { resetsAt: Date.parse(w.resetsAt), windowMinutes: w.windowMinutes, usedPercent: w.usedPercent }, end,
        label ? (id: string) => id.toLowerCase().includes(label) : undefined) };
    }) } : quota,
    tokens, cache: { ...buildCacheReport(records, start, end), basis: 'cache_read_input_tokens / total input tokens',
      scope: tokens.scope },
    dashboard: { status: 'calibrating', remainingMinutes: null,
      text: 'Claude 剩余开发时间：暂无可靠估计（未记录历史额度采样）' },
    limitations: ['Claude plan quota includes activity outside these local transcripts; token counts are observed records, not a bill.',
      'No historical quota snapshots are saved, so remaining active hours are unavailable. Each window pairs its used percentage, a delta from its last reset, with cumulative cycle tokens.',
      'Model token counts are exact for valid recorded usage. Shared quota is not attributed to individual models; only server-scoped limits are labeled by model.',
      'A cycle start is derived as resetsAt minus the window duration; its used percentage includes other devices, so tokens per percentage point is an observed mixed-workload ratio.'],
  };
}

export async function buildGeminiRange(configDir: string, timezone: string, now = Date.now()) {
  let identity: string | null = null;
  try { identity = readClaudeAccountId(configDir); }
  catch { /* Local tokens remain readable without a stored profile ID. */ }
  const end = now, start = dayStart(end, timezone);
  const records = await readClaudeUsageRecords(configDir, start, end);
  if (identity !== null && readClaudeAccountId(configDir) !== identity) throw new Error('Gemini profile account changed during query; rerun.');
  const tokens = { ...buildTokenReport(records, start, end),
    basis: 'Deduplicated Claude Code on Gemini assistant message usage; input = plain input + cache read + cache creation; total = input + output.',
    scope: 'All locally recorded Gemini responses in this profile today, including headless runs and subagents.',
    ownershipBasis: 'Local cg4 transcripts under the isolated Claude config directory.',
  };
  return { title: 'Gemini Remaining Range', agent: 'gemini', capturedAt: new Date(end).toISOString(), timezone,
    status: tokens.samples.at(-1)!.status === 'observed' ? 'observed' : 'partial',
    accountFingerprint: identity ? createHash('sha256').update(identity).digest('hex').slice(0, 12) : null,
    quota: { status: 'unavailable' as const, plan: 'pay-as-you-go', windows: [],
      reason: 'Vertex AI is pay-as-you-go; no percentage quota window applies.' },
    tokens, cache: { ...buildCacheReport(records, start, end), basis: 'cache_read_input_tokens / total input tokens',
      scope: tokens.scope },
    dashboard: { status: 'unavailable', remainingMinutes: null,
      text: 'Gemini (Vertex AI) 按量计费，无百分比额度窗口。' },
    limitations: ['Vertex AI bills per token without a fixed subscription percentage window; only local token consumption and output speed are reported.',
      'Antigravity CLI (ag1/agy) SQLite state stores unannotated binary protobuf blobs without readable token or timing schemas and is not included.'],
  };
}
