/** Incrementally tails owned local profiles; transcript text and source paths never enter worker output. */
import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { TaskOutput } from './task-output.ts';
import { dialogRetentionMs } from './dialog-speed.ts';
import { loadCheckpoint, saveCheckpoint, matches, stamp, type FileStamp } from './task-checkpoint.ts';

type Tail = { offset: number; pending: Buffer; parser: TaskOutput; account: string; owner?: string; samples: Map<string, any>;
  dirty: boolean; stamp?: FileStamp; checkpoint?: ReturnType<TaskOutput['checkpoint']> };
export class TaskWatch {
  private tails = new Map<string, Tail>();
  private seen = new Map<string, Set<string>>();
  private profiles: any[];
  private count: (text: string) => number;
  private identity: (home: string) => string;
  private publish: (sample: any) => void;
  private loaded = false;
  private savedAt = 0;
  private reading = false;
  private closing = false;
  private checkpointPath?: string;
  /** Last time the loop advanced and the step it was in; the worker restarts itself when this stops moving. */
  progressAt = Date.now();
  stage = 'idle';
  private mark(stage: string) { this.stage = stage; this.progressAt = Date.now(); }
  constructor(profiles: any[], count: (text: string) => number, identity: (home: string) => string, publish: (sample: any) => void,
    checkpointPath?: string) {
    this.profiles = profiles; this.count = count; this.identity = identity; this.publish = publish;
    this.checkpointPath = checkpointPath;
  }
  async discover() {
    await this.restore();
    for (const profile of this.profiles) {
      this.mark('discover');
      try {
        if (profile.agent === 'codex') {
          const owner = this.identity(profile.home);
          const names = (await readdir(profile.home)).filter(name => /^state_\d+\.sqlite$/.test(name))
            .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
          if (!names.length) continue;
          const db = new DatabaseSync(resolve(profile.home, names[0]), { readOnly: true });
          try {
            const rows = db.prepare('SELECT rollout_path FROM threads WHERE updated_at >= ? AND creator_account_id = ?')
              .all(Math.floor((Date.now() - dialogRetentionMs) / 1000), owner) as any[];
            for (const row of rows) this.add(row.rollout_path, profile.alias, owner);
          } finally { db.close(); }
        } else if (profile.agent === 'claude') {
          await this.claudeFiles(resolve(profile.home, 'projects'), profile.alias);
        }
      } catch { /* Missing profiles cannot supply conversation measurements. */ }
    }
  }
  private async claudeFiles(dir: string, alias: string, depth = 0) {
    if (depth > 4) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.includes('antigravity-orca-bridge') || entry.name === 'tool-results') continue;
      this.mark('discover');
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await this.claudeFiles(path, alias, depth + 1);
      else if (entry.name.endsWith('.jsonl') && !this.tails.has(path) && (await stat(path)).mtimeMs > Date.now() - dialogRetentionMs) this.add(path, alias);
    }
  }
  private add(path: string, account: string, owner?: string) {
    if (!this.seen.has(account)) this.seen.set(account, new Set());
    if (!this.tails.has(path)) this.tails.set(path, { offset: 0, pending: Buffer.alloc(0),
      parser: new TaskOutput(this.count, account, owner, this.seen.get(account), path), account, owner, samples: new Map(), dirty: true });
  }
  async restore() {
    if (this.loaded) return;
    this.loaded = true;
    const saved = this.checkpointPath && await loadCheckpoint(this.checkpointPath);
    if (!saved) return;
    this.savedAt = Date.now();
    for (const profile of this.profiles) {
      try {
        const owner = profile.agent === 'codex' ? this.identity(profile.home) : undefined;
        const rows = saved.tails.filter((row: any) => row.account === profile.alias);
        if (!rows.length || rows.some((row: any) => row.home !== profile.home || row.owner !== owner)) continue;
        const checks: boolean[] = [];
        for (let offset = 0; offset < rows.length; offset += 16) {
          this.mark('restore');
          checks.push(...await Promise.all(rows.slice(offset, offset + 16)
            .map((row: any) => matches(row.path, row.offset, row.stamp))));
        }
        if (profile.agent === 'codex' && !checks.every(Boolean)) continue;
        this.seen.set(profile.alias, new Set(saved.seen.find(([alias]: any) => alias === profile.alias)?.[1] ?? []));
        for (let i = 0; i < rows.length; i++) {
          if (!checks[i]) continue;
          const row = rows[i];
          this.add(row.path, profile.alias, owner);
          const tail = this.tails.get(row.path)!;
          tail.parser.restore(row.parser); tail.offset = row.offset; tail.dirty = false;
          tail.stamp = row.stamp; tail.checkpoint = row.parser;
          for (const sample of row.samples) if (Date.parse(sample.sampledAt) > Date.now() - dialogRetentionMs) {
            tail.samples.set(sample.sampleId, sample); this.publish(sample);
          }
        }
      } catch { /* A changed profile or malformed checkpoint is rebuilt from its owned source. */ }
    }
  }
  async flush() {
    if (!this.checkpointPath || ![...this.tails.values()].some(tail => tail.dirty)) return;
    const tails = [];
    for (const [path, tail] of this.tails) {
      this.mark('flush:stamp');
      try {
        const offset = tail.offset - tail.pending.length;
        for (const [id, sample] of tail.samples) if (Date.parse(sample.sampledAt) <= Date.now() - dialogRetentionMs) tail.samples.delete(id);
        const samples = [...tail.samples.values()];
        if (tail.dirty || !tail.stamp || !tail.checkpoint) {
          tail.stamp = await stamp(path, offset);
          tail.checkpoint = tail.parser.checkpoint();
          tail.dirty = false;
        }
        tails.push({ path, account: tail.account, owner: tail.owner, offset, parser: tail.checkpoint,
          home: this.profiles.find(profile => profile.alias === tail.account)?.home, samples, stamp: tail.stamp });
      } catch { /* Vanished transcripts are rediscovered without reusing their checkpoint. */ }
    }
    this.mark('flush:save');
    await saveCheckpoint(this.checkpointPath, { version: 1, tails, seen: [...this.seen].map(([alias, ids]) => [alias, [...ids]]) });
    this.savedAt = Date.now();
    this.mark('flush:done');
  }
  async close() {
    this.closing = true;
    while (this.reading) await new Promise(resolve => setTimeout(resolve, 10));
    await this.flush();
  }
  async poll() {
    if (this.reading || this.closing) return;
    this.reading = true;
    try {
    for (const [path, tail] of this.tails) {
      if (this.closing) break;
      this.mark('poll:stat');
      try {
        const info = await stat(path), size = info.size;
        if (size < tail.offset) { this.tails.delete(path); this.seen.get(tail.account)?.clear(); this.add(path, tail.account, tail.owner); continue; }
        if (size === tail.offset) { if (tail.stamp && info.mtimeMs !== tail.stamp.mtimeMs) tail.dirty = true; continue; }
        this.mark('poll:read');
        const input = createReadStream(path, { start: tail.offset, end: size - 1 });
        let pending = tail.pending;
        for await (const chunk of input) {
          pending = Buffer.concat([pending, chunk]);
          let index: number;
          while ((index = pending.indexOf(10)) >= 0) {
            const line = pending.subarray(0, index).toString('utf8'); pending = pending.subarray(index + 1);
            try {
              const sample = tail.parser.accept(JSON.parse(line), Date.now() - dialogRetentionMs);
              if (sample) { tail.samples.set(sample.sampleId, sample); this.publish(sample); }
            } catch { /* Incomplete or malformed records cannot supply a speed sample. */ }
          }
          tail.offset += chunk.length; tail.pending = pending; tail.dirty = true;
          this.mark('poll:read');
          // Yield between chunks so startup progress and the supervisor stay responsive during backfill.
          await new Promise<void>(resolve => setImmediate(resolve));
          if (this.closing) break;
        }
      } catch { this.tails.delete(path); }
    }
    if (Date.now() - this.savedAt >= 30_000) await this.flush();
    this.mark('idle');
    } finally { this.reading = false; }
  }
}
