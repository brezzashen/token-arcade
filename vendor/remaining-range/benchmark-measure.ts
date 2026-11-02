/** Measures one isolated streaming code-analysis response. Visible throughput subtracts reasoning tokens and requires one response, one agent message and multiple chunks; speed.test.ts covers invalid/partial measurements. */
import { performance } from 'node:perf_hooks';
import type { BenchmarkRpc, RpcEvent } from './benchmark-rpc.ts';
import { normalizeTier } from './speed-cost.ts';

export type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
export class StreamMeasurement {
  first: number | null = null;
  last: number | null = null;
  chunks = 0;
  text = '';
  messages = new Set<string>();
  responses = new Map<string, { usage: Usage | null; tier: string | null }>();
  invalid: string | null = null;
  started: number;
  constructor(started: number) { this.started = started; }
  accept(event: RpcEvent, at: number) {
    const p = event.params;
    if (event.method === 'item/agentMessage/delta' && typeof p.delta === 'string' && p.delta.length) {
      this.first ??= at; this.last = at; this.chunks++; this.text += p.delta; this.messages.add(p.itemId);
    }
    if (event.method === 'rawResponse/completed') {
      if (typeof p.responseId !== 'string' || !p.responseId) this.invalid = 'missing_response_id';
      const u = p.usage;
      const valid = u && [u.inputTokens, u.cachedInputTokens, u.outputTokens, u.reasoningOutputTokens]
        .every(v => Number.isSafeInteger(v) && v >= 0) && u.cachedInputTokens <= u.inputTokens && u.reasoningOutputTokens <= u.outputTokens;
      const metadata = p.usageMetadata?.metadata;
      const tier = typeof metadata?.service_tier === 'string' ? metadata.service_tier : null;
      this.responses.set(p.responseId, { usage: valid ? u : null, tier });
    }
    if (event.method === 'model/rerouted') this.invalid = 'model_rerouted';
    if (event.method === 'benchmark/toolRequest') this.invalid = 'tool_call_contaminated';
    if (event.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning'].includes(p.item?.type)) {
      this.invalid = 'tool_or_non_message_item';
    }
  }
  finish(completed: number, status = 'completed') {
    const response = this.responses.size === 1 ? [...this.responses.values()][0] : null;
    const usage = response?.usage ?? null;
    const visible = usage ? usage.outputTokens - usage.reasoningOutputTokens : null;
    const elapsedMs = completed - this.started;
    const outputMs = this.first !== null && this.last !== null ? this.last - this.first : null;
    const reason = this.invalid ?? (status !== 'completed' ? `turn_${status}`
      : this.responses.size !== 1 ? 'requires_one_recorded_response'
        : !usage ? 'missing_or_invalid_token_usage'
          : this.messages.size !== 1 ? 'requires_one_agent_message'
            : this.chunks < 2 || !outputMs || outputMs <= 0 ? 'insufficient_streaming_chunks'
              : !visible ? 'no_visible_tokens' : null);
    return { status: reason ? 'unavailable' : 'ok', reason, elapsedMs,
      firstTextMs: this.first === null ? null : this.first - this.started, outputMs,
      visibleOutputTokens: visible, reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
      inputTokens: usage?.inputTokens ?? null, cachedInputTokens: usage?.cachedInputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null, chunks: this.chunks, outputCharacters: this.text.length,
      outputWords: this.text.trim().split(/\s+/).filter(Boolean).length,
      hasSourceCitation: /\.[a-z]+:\d+/.test(this.text),
      visibleTokensPerSecond: !reason ? visible! / (outputMs! / 1000) : null,
      endToEndVisibleTokensPerSecond: !reason && elapsedMs > 0 ? visible! / (elapsedMs / 1000) : null,
      servedTier: response?.tier ?? null };
  }
}

export type Trial = ReturnType<StreamMeasurement['finish']> & {
  model: string; mode: string; requestedTier: string; configuredTier: string | null; speedBasis: string;
  effort: string; round: number; order: number;
};

export function skippedTrial(model: string, mode: string, effort: string, round: number, order: number, reason: string): Trial {
  return { ...new StreamMeasurement(0).finish(0, 'skipped'), reason, model, mode, effort, round, order,
    requestedTier: mode === 'fast' ? 'priority' : 'default', configuredTier: null, speedBasis: 'request' };
}

export async function measureTrial(rpc: BenchmarkRpc, params: {
  model: string; mode: string; effort: string; round: number; order: number; timeoutMs: number; prompt: string; cwd: string;
  disabledMcpServers?: string[];
}): Promise<Trial> {
  const { model, mode, effort, round, order } = params;
  const requestedTier = mode === 'fast' ? 'priority' : 'default';
  const thread = await rpc.call('thread/start', { model, serviceTier: requestedTier, cwd: params.cwd,
    ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', experimentalRawEvents: true,
    baseInstructions: 'You analyze supplied source code in one response. Never call tools, delegate, or change files.',
    config: { model_reasoning_effort: effort, project_doc_max_bytes: 0, web_search: 'disabled',
      ...Object.fromEntries((params.disabledMcpServers ?? []).map(name => [`mcp_servers.${name}.enabled`, false])) } });
  const threadId = thread.thread.id;
  if (thread.model !== model || normalizeTier(thread.serviceTier) !== mode || thread.reasoningEffort !== effort) {
    await rpc.call('thread/unsubscribe', { threadId });
    return skippedTrial(model, mode, effort, round, order, 'requested_settings_not_applied');
  }
  const measure = new StreamMeasurement(performance.now());
  let turnId: string | null = null, unsubscribe = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<ReturnType<StreamMeasurement['finish']>>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('trial_timeout')), params.timeoutMs);
    unsubscribe = rpc.subscribe(event => {
      if (event.method === 'transport/error') { reject(new Error(event.params.code)); return; }
      if (event.method === 'benchmark/toolRequest') { measure.accept(event, performance.now()); return; }
      if (event.params?.threadId !== threadId) return;
      if (event.method === 'turn/started') turnId = event.params.turn.id;
      measure.accept(event, performance.now());
      if (event.method === 'turn/completed') {
        const code = event.params.turn.error?.codexErrorInfo;
        if (event.params.turn.status !== 'completed' && typeof code === 'string') measure.invalid = code;
        resolve(measure.finish(performance.now(), event.params.turn.status));
      }
    });
  });
  // Handle completion/transport failure even while turn/start is still awaiting its RPC response.
  void done.catch(() => {});
  try {
    const start = await rpc.call('turn/start', { threadId, model, effort, serviceTierForTurn: requestedTier,
      input: [{ type: 'text', text: params.prompt }], environments: [] });
    turnId ??= start.turn.id;
    const result = await done;
    if (result.servedTier && normalizeTier(result.servedTier) !== mode) {
      result.status = 'unavailable'; result.reason = 'served_tier_differs_from_request';
      result.visibleTokensPerSecond = null; result.endToEndVisibleTokensPerSecond = null;
    }
    return { ...result, model, mode, effort, round, order, requestedTier, configuredTier: thread.serviceTier,
      speedBasis: result.servedTier ? 'response' : 'request' };
  } catch (error) {
    if (turnId) await rpc.call('turn/interrupt', { threadId, turnId }).catch(() => {});
    const reason = error instanceof Error ? error.message : 'trial_failed';
    return { ...skippedTrial(model, mode, effort, round, order, reason), elapsedMs: performance.now() - measure.started };
  } finally {
    clearTimeout(timer); unsubscribe();
    await rpc.call('thread/unsubscribe', { threadId }).catch(() => {});
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 : null;
};

export function summarizeTrials(trials: Trial[]) {
  const groups = [...new Set(trials.map(t => `${t.model}|${t.mode}`))].map(key => {
    const rows = trials.filter(t => `${t.model}|${t.mode}` === key), first = rows[0];
    const ok = rows.filter(t => t.status === 'ok');
    return { model: first.model, mode: first.mode, samples: ok.length, attempted: rows.length,
      speedBasis: ok.length && ok.every(t => t.speedBasis === 'response') ? 'response' : 'request',
      medianTokensPerSecond: median(ok.map(t => t.visibleTokensPerSecond!)),
      medianFirstTextMs: median(ok.map(t => t.firstTextMs!)), medianElapsedMs: median(ok.map(t => t.elapsedMs)),
      failures: rows.filter(t => t.status !== 'ok').map(t => t.reason) };
  });
  const comparisons = [...new Set(trials.map(t => t.model))].map(model => {
    const standard = groups.find(g => g.model === model && g.mode === 'standard');
    const fast = groups.find(g => g.model === model && g.mode === 'fast');
    const paired = trials.filter(t => t.model === model && t.mode === 'standard' && t.status === 'ok')
      .flatMap(s => {
        const f = trials.find(t => t.model === model && t.mode === 'fast' && t.round === s.round && t.status === 'ok' && t.speedBasis === s.speedBasis);
        return f ? [f.visibleTokensPerSecond! / s.visibleTokensPerSecond!] : [];
      });
    return { model, standard, fast, pairedRounds: paired.length, fastOutputSpeedRatio: median(paired),
      status: paired.length ? 'measured' : 'insufficient_samples' };
  });
  return { groups, comparisons };
}
