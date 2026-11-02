/** Keeps one SSH stream per remote host agent and serves the latest sanitized snapshot of each. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RemoteHost, RemoteSnapshot } from './web/remote-hosts.ts';

export type RemoteHostSpec = { id: string; label: string; platform: 'win32' | 'darwin'; agentPath: string; command: string };

// SSH aliases from ~/.ssh/config; the installer writes the agent to `agentPath` and the server runs `command`.
export const remoteHostSpecs: Record<string, RemoteHostSpec> = {
  win: { id: 'win', label: 'Windows', platform: 'win32', agentPath: '%LOCALAPPDATA%\\token-host-agent\\host-agent.mjs',
    command: 'node "%LOCALAPPDATA%\\token-host-agent\\host-agent.mjs"' },
  mbp: { id: 'mbp', label: 'Mac (SSH)', platform: 'darwin', agentPath: '$HOME/.local/share/token-host-agent/host-agent.mjs',
    command: 'PATH=/opt/homebrew/bin:/usr/local/bin:$PATH exec node "$HOME/.local/share/token-host-agent/host-agent.mjs"' },
};

export function parseRemoteHosts(value = ''): RemoteHostSpec[] {
  return value.split(',').map(id => id.trim()).filter(Boolean).map(id => {
    const spec = remoteHostSpecs[id];
    if (!spec) throw new Error(`Unknown remote host: ${id}`);
    return spec;
  });
}

export const sshArgs = (alias: string, command: string) => ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', alias, command];

/** Maps an SSH or agent failure to a short label; raw stderr never reaches the page. */
export function failureLabel(code: number | null, stderr: string): string {
  if (/Cannot find module|MODULE_NOT_FOUND/.test(stderr)) return '采集端未安装';
  if (/not recognized|command not found|无法将|不是内部或外部命令/.test(stderr)) return '缺少 Node.js';
  if (code === 255) return 'SSH 连接失败';
  return `采集端退出 (${code ?? 'signal'})`;
}

export const STALE_AFTER_MS = 10_000;

export function startRemoteHosts(specs: RemoteHostSpec[], log: (message: string) => void = () => {}) {
  type State = { spec: RemoteHostSpec; snapshot: RemoteSnapshot | null; receivedAt: number; error: string | null;
    child: ChildProcess | null; delayMs: number; timer: NodeJS.Timeout | null };
  const states = specs.map((spec): State => ({ spec, snapshot: null, receivedAt: 0, error: null, child: null, delayMs: 5000, timer: null }));
  let stopped = false;

  const connect = (state: State) => {
    if (stopped) return;
    let stderr = '';
    const child = spawn('ssh', sshArgs(state.spec.id, state.spec.command), { stdio: ['pipe', 'pipe', 'pipe'] });
    state.child = child;
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    createInterface({ input: child.stdout! }).on('line', line => {
      if (line.length > 256 * 1024) return;
      try {
        const snapshot = JSON.parse(line) as RemoteSnapshot;
        // Remote clocks may drift; freshness and the shown time use this server's receive time.
        state.snapshot = { ...snapshot, observedAt: new Date().toISOString(), stale: false };
        state.receivedAt = Date.now();
        state.error = null;
        state.delayMs = 5000;
      } catch { /* Ignore a partial or foreign line. */ }
    });
    child.on('error', () => { /* `close` follows and schedules the retry. */ });
    child.on('close', code => {
      state.child = null;
      if (stopped) return;
      state.error = failureLabel(code, stderr);
      log(`remote ${state.spec.id} closed (${code}); retry in ${state.delayMs / 1000}s`);
      state.timer = setTimeout(() => connect(state), state.delayMs);
      state.delayMs = Math.min(60_000, state.delayMs * 2);
    });
  };
  states.forEach(connect);

  return {
    read(): RemoteHost[] {
      return states.map(({ spec, snapshot, receivedAt, error }) => {
        const stale = snapshot === null || Date.now() - receivedAt > STALE_AFTER_MS;
        return { id: spec.id, label: spec.label, snapshot: snapshot && { ...snapshot, stale }, stale, error: stale ? error : null };
      });
    },
    stop() {
      stopped = true;
      for (const state of states) {
        if (state.timer) clearTimeout(state.timer);
        state.child?.kill('SIGTERM');
      }
    },
  };
}
