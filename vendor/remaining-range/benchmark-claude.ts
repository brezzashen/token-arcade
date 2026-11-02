/** Runs one bounded Claude CLI analysis without tools or persisted sessions. Normalizes partial Messages events into the shared visible-token measurement; missing thinking counters remain unavailable rather than inflated throughput. */
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StreamMeasurement, skippedTrial } from './benchmark-measure.ts';
import type { Trial } from './benchmark-measure.ts';

export function claudeEnvironment(home?: string) {
  return home ? { ...process.env, CLAUDE_CONFIG_DIR: home } : { ...process.env };
}

export function claudeIdentity(home?: string) {
  const raw = execFileSync('claude', ['auth', 'status'], { env: claudeEnvironment(home),
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const account = JSON.parse(raw);
  if (!account.loggedIn) throw new Error('claude_not_logged_in');
  return createHash('sha256').update(String(account.orgId ?? '') + ':' + String(account.email ?? account.authMethod)).digest('hex').slice(0, 12);
}

export class ClaudeStreamMeasurement {
  measurement: StreamMeasurement;
  model: string | null = null;
  messageId: string | null = null;
  input: any = {};
  usage: any = {};
  thinking = false;
  result: any = null;
  constructor(started: number) { this.measurement = new StreamMeasurement(started); }
  accept(record: any, at: number) {
    const event = record.type === 'stream_event' ? record.event : null;
    if (event?.type === 'message_start') {
      if (this.messageId) this.measurement.invalid = 'requires_one_recorded_response';
      this.messageId = event.message.id; this.model = event.message.model;
      this.input = event.message.usage ?? {}; this.usage = { ...this.input };
    }
    if (event?.type === 'content_block_start' && ['thinking', 'redacted_thinking'].includes(event.content_block?.type)) this.thinking = true;
    if (event?.type === 'content_block_start' && ['tool_use', 'server_tool_use', 'fallback'].includes(event.content_block?.type)) {
      this.measurement.invalid = 'tool_or_model_fallback';
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      this.measurement.accept({ method: 'item/agentMessage/delta', params: { itemId: this.messageId, delta: event.delta.text } }, at);
    }
    if (event?.type === 'message_delta') this.usage = { ...this.usage, ...event.usage };
    if (record.type === 'assistant' && record.message?.usage) this.usage = { ...this.usage, ...record.message.usage };
    if (record.type === 'result') this.result = record;
  }
  finish(completed: number, requestedModel: string) {
    const u = this.usage, details = u.output_tokens_details;
    const thinkingTokens = details?.thinking_tokens ?? (this.thinking ? null : 0);
    const parts = [u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
    const validInput = parts.every(v => Number.isSafeInteger(v) && v >= 0);
    if (this.model !== requestedModel) this.measurement.invalid = 'model_mismatch_or_unavailable';
    if (thinkingTokens === null) this.measurement.invalid = 'missing_thinking_token_count';
    if (this.result?.num_turns !== 1) this.measurement.invalid = 'requires_one_cli_turn';
    this.measurement.accept({ method: 'rawResponse/completed', params: { responseId: this.messageId,
      usage: { inputTokens: validInput ? parts.reduce((a, b) => a + b, 0) : -1,
        cachedInputTokens: u.cache_read_input_tokens ?? 0, outputTokens: u.output_tokens, reasoningOutputTokens: thinkingTokens },
      usageMetadata: { metadata: { service_tier: u.speed ?? 'unknown' } } } }, completed);
    return { ...this.measurement.finish(completed, this.result?.is_error || !this.result ? 'failed' : 'completed'),
      apiDurationMs: this.result?.duration_api_ms ?? null, estimatedCostUsd: this.result?.total_cost_usd ?? null,
      numTurns: this.result?.num_turns ?? null, actualModel: this.model,
      thinkingTokenBasis: details?.thinking_tokens !== undefined ? 'explicit_usage_counter' : this.thinking ? 'missing_counter' : 'no_thinking_blocks_observed' };
  }
}

export function claudeArgs(model: string, effort: string, budgetUsd: number) {
  return ['-p', '--model', model, '--effort', effort, '--max-turns', '1', '--max-budget-usd', String(budgetUsd),
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
    '--no-chrome', '--safe-mode', '--setting-sources', '', '--settings', '{"fastMode":false,"disableAllHooks":true}',
    '--system-prompt', 'Analyze only the supplied project source in one short reply. Do not use tools or delegate.'];
}

export async function measureClaudeTrial(params: {
  model: string; effort: string; order: number; prompt: string; project: string; home?: string; timeoutMs: number; budgetUsd: number;
}): Promise<Trial> {
  const start = performance.now(), measurement = new ClaudeStreamMeasurement(start);
  const proc = spawn('claude', claudeArgs(params.model, params.effort, params.budgetUsd), {
    cwd: params.project, env: { ...claudeEnvironment(params.home),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1200', ANTHROPIC_MAX_RETRIES: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = createInterface({ input: proc.stdout }); proc.stderr.resume();
  reader.on('line', line => { try { measurement.accept(JSON.parse(line), performance.now()); } catch { measurement.measurement.invalid = 'malformed_cli_event'; } });
  let timedOut = false;
  const terminate = () => { proc.kill(); const kill = setTimeout(() => proc.kill('SIGKILL'), 1000); kill.unref(); };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, params.timeoutMs);
  process.once('SIGINT', terminate); process.once('SIGTERM', terminate);
  proc.stdin.on('error', () => {}); proc.stdin.end(params.prompt);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { proc.on('close', resolve); proc.on('error', reject); });
    const result = measurement.finish(performance.now(), params.model);
    if (timedOut || code !== 0 || (result.servedTier && !['standard', 'default', 'unknown'].includes(result.servedTier))) {
      result.status = 'unavailable'; result.reason = timedOut ? 'trial_timeout' : code !== 0 ? 'claude_cli_failed' : 'served_tier_differs_from_request';
      result.visibleTokensPerSecond = null; result.endToEndVisibleTokensPerSecond = null;
    }
    return { ...result, model: params.model, mode: 'standard', requestedTier: 'standard', configuredTier: 'standard',
      speedBasis: result.servedTier && result.servedTier !== 'unknown' ? 'response' : 'request', effort: params.effort, round: 1, order: params.order };
  } catch {
    return skippedTrial(params.model, 'standard', params.effort, 1, params.order, 'claude_cli_unavailable');
  } finally {
    clearTimeout(timer); reader.close(); process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate); terminate();
  }
}
