/** Read Antigravity 1.3.x response metadata without loading message text or executing model calls. */
import { DatabaseSync } from 'node:sqlite';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { dialogRetentionMs } from './dialog-speed.ts';

type Wire = Map<number, (number | Buffer)[]>;
/** Minimal protobuf wire reader. Unknown fields are skipped; truncated records cannot produce a sample. */
export function decodeWire(bytes: Uint8Array): Wire {
  const buffer = Buffer.from(bytes), fields: Wire = new Map();
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= buffer.length) throw new Error('Truncated protobuf varint.');
      const byte = buffer[offset++]; value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return Number(value);
    }
    throw new Error('Invalid protobuf varint.');
  };
  while (offset < buffer.length) {
    const tag = varint(), field = Math.floor(tag / 8), type = tag % 8;
    if (!field) throw new Error('Invalid protobuf field.');
    let value: number | Buffer;
    if (type === 0) value = varint();
    else if (type === 2) {
      const size = varint();
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > buffer.length) throw new Error('Truncated protobuf bytes.');
      value = buffer.subarray(offset, offset + size); offset += size;
    } else if (type === 1 || type === 5) {
      offset += type === 1 ? 8 : 4;
      if (offset > buffer.length) throw new Error('Truncated protobuf fixed field.');
      continue;
    } else throw new Error('Unsupported protobuf wire type.');
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  return fields;
}
export const first = (wire: Wire, field: number) => wire.get(field)?.[0];
export const nested = (wire: Wire, field: number): Wire => {
  const bytes = first(wire, field); return Buffer.isBuffer(bytes) ? decodeWire(bytes) : new Map();
};
export const number = (wire: Wire, field: number): number | undefined => {
  const value = first(wire, field); return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};
const timestamp = (wire: Wire, field: number) => {
  const value = nested(wire, field), seconds = number(value, 1), nanos = number(value, 2) ?? 0;
  return seconds === undefined || nanos >= 1e9 ? NaN : Math.floor(seconds * 1000 + nanos / 1e6);
};

/** CortexStepMetadata: created_at=1, finished_generating_at=7, model_usage=9.
 * ModelUsage: model=1, output_tokens=3, api_provider=6 (GOOGLE_VERTEX=3, GOOGLE_GEMINI=24, ANTHROPIC_VERTEX=26, GOOGLE_EVERGREEN=30, OPENAI_VERTEX=31).
 * Generator info names model_enum=3 and model_name=19.
 * The interval includes time to first token, but ends before tool execution. It is not a pure decoder benchmark. */
export function antigravityResponse(metadata: Uint8Array, id: string, conversation: string,
  modelNames: Map<number, string>, since: number, now = Date.now()) {
  const wire = decodeWire(metadata), usage = nested(wire, 9);
  const start = timestamp(wire, 1), end = timestamp(wire, 7);
  const tokens = number(usage, 3), enumId = number(usage, 1), provider = number(usage, 6);
  const isVertex = provider !== undefined && [3, 26, 31].includes(provider);
  const mode = isVertex ? 'vertex'
    : provider !== undefined && [24, 30].includes(provider) ? 'subscription' : 'unknown';
  const account = isVertex ? 'ag2' : 'ag1';
  const model = enumId === undefined ? undefined : modelNames.get(enumId);
  const duration = end - start;
  if (!model || tokens === undefined || tokens <= 0 || !Number.isFinite(duration)
    || duration < 250 || start < since || end > now + 1000) return null;
  return { model, account, sampleId: `agy:${conversation}:${id}`, conversationId: conversation,
    mode, speedBasis: 'response', kind: 'response', source: 'task', status: 'sampled', reason: null,
    sampledAt: new Date(end).toISOString(), startedAt: new Date(start).toISOString(),
    updatedAt: new Date(now).toISOString(), measuredTokens: tokens, estimatedTokens: tokens,
    outputMs: duration, tokensPerSecond: tokens / (duration / 1000), firstTextMs: null,
    basis: 'recorded_response_including_first_token_wait' };
}

export function readConversationModels(db: DatabaseSync) {
  const models = new Map<number, string>();
  for (const row of db.prepare('SELECT data FROM gen_metadata').all() as { data: Uint8Array }[]) {
    try {
      const info = nested(decodeWire(row.data), 1), enumId = number(info, 3), model = first(info, 19);
      if (enumId !== undefined && Buffer.isBuffer(model) && /^[a-z0-9][a-z0-9._-]{1,100}$/i.test(model.toString())) models.set(enumId, model.toString());
    } catch { /* Unrecognized metadata remains unavailable. */ }
  }
  return models;
}

const dbCache = new Map<string, { mtimeMs: number; samples: any[] }>();

export async function readAntigravitySpeed(home = homedir(), now = Date.now()) {
  const directory = join(home, '.gemini/antigravity-cli/conversations');
  const samples: any[] = [];
  let names: string[];
  try { names = await readdir(directory); } catch { return samples; }
  for (const name of names.filter(name => name.endsWith('.db'))) {
    const path = join(directory, name);
    try {
      const wal = await stat(path + '-wal').catch(() => null);
      const mtimeMs = Math.max((await stat(path)).mtimeMs, wal?.mtimeMs ?? 0);
      if (mtimeMs < now - dialogRetentionMs) { dbCache.delete(path); continue; }
      let cached = dbCache.get(path);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          const models = readConversationModels(db);
          const steps = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3').all() as { idx: number; metadata: Uint8Array }[];
          const conversation = basename(name, '.db'), since = now - dialogRetentionMs;
          const decoded = steps.flatMap(row => {
            try {
              const sample = antigravityResponse(row.metadata, String(row.idx), conversation, models, since, now);
              return sample ? [sample] : [];
            } catch { return []; }
          });
          cached = { mtimeMs, samples: decoded };
          if (dbCache.size > 256) dbCache.delete(dbCache.keys().next().value!);
          dbCache.set(path, cached);
        } finally { db.close(); }
      }
      for (const sample of cached.samples) if (Date.parse(sample.sampledAt) > now - dialogRetentionMs) samples.push(sample);
    } catch { /* A database can disappear when the CLI deletes a conversation. */ }
  }
  return samples;
}
