/** Runs one bounded, tool-free streaming sample using installed CLI logins; publishes content-derived aggregates only. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';
import { ContentSpeed } from './content-speed.ts';

const [script, model] = process.argv.slice(2);
if (!script || !model) throw new Error('Range script and model are required.');
const claude = model.startsWith('claude-');
const encoder = new Tiktoken(ranks);
const meter = new ContentSpeed(text => encoder.encode(text, [], []).length);
const started = performance.now();
const sampledAt = new Date().toISOString();
const prompt = 'Write a plain English description of a quiet coastal town in about 500 words. Start the description immediately. Use no tools, headings, lists or code. Produce one response.';
let firstTextMs: number | null = null;
let cleanup = () => {};
let lastEmit = 0;
function emit(status: string, reason: string | null = null) {
  const now = performance.now();
  if (status === 'streaming' && now - lastEmit < 250) return;
  lastEmit = now;
  const reading = meter.reading();
  process.stdout.write(JSON.stringify({ model, account: claude ? 'cc1' : 'co1', mode: 'standard', speedBasis: 'request',
    status, reason, sampledAt, updatedAt: new Date().toISOString(), firstTextMs,
    ...reading, tokensPerSecond: status === 'unavailable' ? null : reading.tokensPerSecond,
    tokenizer: 'o200k_base', basis: 'content_estimate' }) + '\n');
}
function delta(text: string) {
  if (!text) return;
  firstTextMs ??= performance.now() - started;
  meter.accept(text, performance.now());
  emit('streaming');
}
const load = (file: string) => import(pathToFileURL(resolve(dirname(script), file)).href);
const timeout = setTimeout(() => { emit('unavailable', 'timeout'); cleanup(); process.exit(1); }, 90_000);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { cleanup(); process.exit(1); });
emit('waiting');
try {
  if (claude) {
    const { claudeArgs } = await load('benchmark-claude.ts');
    const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1200', ANTHROPIC_MAX_RETRIES: '0' };
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[key];
    const args = claudeArgs(model, 'medium', 0.20);
    args[args.indexOf('--system-prompt') + 1] = 'Respond to the supplied writing prompt once. Never call tools or delegate.';
    const child = spawn('claude', args, { cwd: homedir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    cleanup = () => child.kill('SIGTERM');
    child.stderr.resume();
    const reader = createInterface({ input: child.stdout });
    let actualModel: string | null = null, valid = false, invalid = false, messages = 0;
    reader.on('line', line => {
      try {
        const record = JSON.parse(line), event = record.event;
        if (event?.type === 'message_start') { actualModel = event.message.model; if (++messages > 1) invalid = true; }
        if (event?.type === 'content_block_start' && /tool_use/.test(event.content_block?.type)) invalid = true;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') delta(event.delta.text);
        if (record.type === 'result') valid = !record.is_error && record.num_turns === 1;
      } catch { invalid = true; }
    });
    child.stdin.end(prompt);
    const code = await new Promise(resolveExit => { child.on('close', resolveExit); child.on('error', () => resolveExit(-1)); });
    reader.close();
    if (code !== 0 || !valid || invalid || actualModel !== model) throw new Error('sample_unavailable');
  } else {
    const { openBenchmarkRpc } = await load('benchmark-rpc.ts');
    const rpc = await openBenchmarkRpc(resolve(homedir(), '.codex'), homedir());
    cleanup = () => rpc.close();
    const account = await rpc.call('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') throw new Error('sample_unavailable');
    const config = await rpc.call('config/read', { includeLayers: false, cwd: homedir() });
    const thread = await rpc.call('thread/start', { model, serviceTier: 'default', cwd: homedir(), ephemeral: true,
      approvalPolicy: 'never', sandbox: 'read-only', experimentalRawEvents: true,
      baseInstructions: 'Respond to the supplied writing prompt once. Never call tools or delegate.',
      config: { model_reasoning_effort: 'medium', project_doc_max_bytes: 0, web_search: 'disabled',
        ...Object.fromEntries(Object.keys(config.config?.mcp_servers ?? {}).map(name => [`mcp_servers.${name}.enabled`, false])) } });
    if (thread.model !== model || thread.serviceTier !== 'default') throw new Error('sample_unavailable');
    let invalid = false;
    const messages = new Set<string>();
    const done = new Promise<void>((resolveDone, reject) => rpc.subscribe((event: any) => {
      if (event.method === 'transport/error') { reject(new Error('sample_unavailable')); return; }
      if (event.params?.threadId !== thread.thread.id) return;
      if (event.method === 'model/rerouted' || event.method === 'benchmark/toolRequest') invalid = true;
      if (event.method === 'item/started' && !['userMessage', 'reasoning', 'agentMessage'].includes(event.params.item?.type)) invalid = true;
      if (event.method === 'item/agentMessage/delta') {
        messages.add(event.params.itemId);
        if (messages.size > 1) invalid = true;
        delta(event.params.delta);
      }
      if (event.method === 'turn/completed') {
        if (event.params.turn.status !== 'completed' || invalid) reject(new Error('sample_unavailable'));
        else resolveDone();
      }
    }));
    void done.catch(() => {});
    await rpc.call('turn/start', { threadId: thread.thread.id, model, effort: 'medium', serviceTierForTurn: 'default',
      input: [{ type: 'text', text: prompt }], environments: [] });
    await done;
  }
  emit(meter.reading().tokensPerSecond === null ? 'unavailable' : 'sampled', meter.reading().tokensPerSecond === null ? 'insufficient_chunks' : null);
} catch { emit('unavailable', 'sample_unavailable'); }
finally { clearTimeout(timeout); cleanup(); }
