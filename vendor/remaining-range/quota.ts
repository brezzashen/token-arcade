/** Exports the local in-memory account identity and reads authenticated Codex limits through stdio RPC; quota output uses a sanitized fingerprint. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type Window = { key: string; bucket: string; slot: string; used: number; minutes: number; reset: number };
export type LiveQuota = {
  at: number; accountId: string; fingerprint: string; plan: string;
  windows: Window[]; extras: unknown[]; resetCount: number | null;
};

export function readAccountId(home: string): string {
  const auth = JSON.parse(readFileSync(`${home}/auth.json`, 'utf8'));
  const id = auth.tokens?.account_id;
  if (typeof id !== 'string' || !id) throw new Error('No local ChatGPT account identity available.');
  return id;
}

export async function fetchQuota(home: string): Promise<LiveQuota> {
  const accountId = readAccountId(home);
  const proc = spawn('codex', ['app-server'], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = createInterface({ input: proc.stdout });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let next = 0;
  const fail = (message: string) => { for (const p of pending.values()) p.reject(new Error(message)); pending.clear(); };
  proc.on('error', () => fail('Unable to launch codex app-server.'));
  proc.on('exit', () => fail('Codex app-server exited before returning quota.'));
  proc.stderr.resume();
  proc.stdin.on('error', () => fail('Codex app-server input closed.'));
  reader.on('line', line => {
    let data: any;
    try { data = JSON.parse(line); } catch { return; }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(`Codex RPC failed (code ${data.error.code ?? 'unknown'}).`));
    else p.resolve(data.result);
  });
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timer = setTimeout(() => { fail('Quota read timed out after 25 seconds.'); proc.kill(); }, 25_000);
  try {
    await call('initialize', { clientInfo: { name: 'remaining_range', title: 'Remaining Range', version: '1.0.0' } });
    proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const account = (await call('account/read', { refreshToken: false })).account;
    if (account?.type !== 'chatgpt') throw new Error('Current CLI account is not a ChatGPT subscription.');
    const result = await call('account/rateLimits/read');
    if (readAccountId(home) !== accountId) throw new Error('Account changed during quota read; rerun.');
    const buckets = result.rateLimitsByLimitId ?? { [result.rateLimits?.limitId ?? 'codex']: result.rateLimits };
    const windows: Window[] = [], extras: unknown[] = [];
    for (const [id, raw] of Object.entries(buckets)) {
      const bucket = raw as any;
      if (!bucket) continue;
      for (const slot of ['primary', 'secondary']) {
        const w = bucket[slot];
        if (!w) continue;
        if (![w.usedPercent, w.windowDurationMins, w.resetsAt].every(Number.isFinite)
          || w.usedPercent < 0 || w.usedPercent > 100 || w.windowDurationMins <= 0) {
          throw new Error('Unsupported quota window schema.');
        }
        windows.push({ key: `${id}:${slot}`, bucket: id, slot, used: w.usedPercent, minutes: w.windowDurationMins, reset: w.resetsAt * 1000 });
      }
      extras.push({ bucket: id, credits: bucket.credits ?? null, reached: bucket.rateLimitReachedType ?? null });
    }
    if (!windows.length) throw new Error('No percentage quota windows returned.');
    return { at: Date.now(), accountId,
      fingerprint: createHash('sha256').update(accountId).digest('hex').slice(0, 12),
      plan: account.planType ?? 'unknown', windows, extras,
      resetCount: result.rateLimitResetCredits?.availableCount ?? null };
  } finally {
    clearTimeout(timer); reader.close(); proc.stdin.end(); proc.kill();
    const kill = setTimeout(() => proc.kill('SIGKILL'), 1000); kill.unref();
  }
}
