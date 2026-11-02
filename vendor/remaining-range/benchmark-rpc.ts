/** Owns bounded stdio RPC for the active benchmark, unlike quota.ts's single read-only query. Notifications stay in memory; close() terminates the server and all pending waits. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type RpcEvent = { method: string; params: any; id?: number | string };
export interface BenchmarkRpc {
  call(method: string, params?: object): Promise<any>;
  subscribe(listener: (event: RpcEvent) => void): () => void;
  close(): void;
}

export async function openBenchmarkRpc(home: string, cwd: string): Promise<BenchmarkRpc> {
  const disabled = ['shell_tool', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks',
    'memories', 'browser_use', 'computer_use', 'image_generation', 'code_mode', 'code_mode_host'];
  const proc = spawn('codex', ['app-server', ...disabled.flatMap(name => ['--disable', name]),
    '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0'], {
    cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = createInterface({ input: proc.stdout });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(event: RpcEvent) => void>();
  let next = 0, closed = false, failure: Error | null = null;
  function fail(message: string) {
    if (failure) return;
    failure = new Error(message);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(failure); }
    pending.clear();
    for (const listener of listeners) listener({ method: 'transport/error', params: { code: message } });
  }
  proc.on('error', () => fail('app_server_launch_failed'));
  proc.on('exit', () => { if (!closed) fail('app_server_exited'); });
  proc.stdin.on('error', () => fail('app_server_input_closed'));
  proc.stderr.resume();
  reader.on('line', line => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      proc.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Benchmark does not execute client tools.' } })}\n`);
      for (const listener of listeners) listener({ method: 'benchmark/toolRequest', params: {} });
      return;
    }
    if (message.id !== undefined) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new Error(`rpc_error_${message.error.code ?? 'unknown'}`));
      else p.resolve(message.result);
    } else if (typeof message.method === 'string') {
      for (const listener of listeners) listener(message);
    }
  });
  const rpc: BenchmarkRpc = {
    call(method, params = {}) {
      if (closed || failure) return Promise.reject(failure ?? new Error('app_server_closed'));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`rpc_timeout_${method}`)); }, 30_000);
        pending.set(id, { resolve, reject, timer });
        proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() {
      if (closed) return;
      closed = true; fail('app_server_closed'); listeners.clear(); reader.close();
      proc.stdin.end(); proc.kill();
      const timer = setTimeout(() => proc.kill('SIGKILL'), 1000); timer.unref();
    },
  };
  try {
    await rpc.call('initialize', { clientInfo: { name: 'remaining_range_benchmark', title: 'Codex Output Benchmark', version: '1.0.0' },
      capabilities: { experimentalApi: true } });
    proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return rpc;
  } catch (error) { rpc.close(); throw error; }
}
