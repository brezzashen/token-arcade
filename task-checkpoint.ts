/** Private parser checkpoints contain identifiers and measurements, never transcript text. */
import { createHash } from 'node:crypto';
import { open, readFile, mkdir, rename, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip), decompress = promisify(gunzip);
const maxBytes = 256 * 1024 * 1024;

export type FileStamp = { dev: number; ino: number; size: number; mtimeMs: number; prefix: string; boundary: string };
export async function stamp(path: string, offset: number): Promise<FileStamp> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    const hash = async (start: number, size: number) => {
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await file.read(bytes, 0, size, start);
      return createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex');
    };
    return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs,
      prefix: await hash(0, Math.min(offset, 4096)), boundary: await hash(Math.max(0, offset - 256), Math.min(offset, 256)) };
  } finally { await file.close(); }
}
export async function matches(path: string, offset: number, previous: FileStamp): Promise<boolean> {
  try {
    const current = await stamp(path, offset);
    return current.dev === previous.dev && current.ino === previous.ino && current.size >= offset
      && !(current.size === previous.size && current.mtimeMs !== previous.mtimeMs)
      && current.prefix === previous.prefix && current.boundary === previous.boundary;
  } catch { return false; }
}
export async function loadCheckpoint(path: string) {
  try {
    let source = path;
    if (path.endsWith('.gz') && !(await stat(path).catch(() => null))) source = path.slice(0, -3);
    if ((await stat(source)).size > maxBytes) return null;
    const bytes = await readFile(source);
    const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? await decompress(bytes, { maxOutputLength: maxBytes }) : bytes;
    const value = JSON.parse(decoded.toString('utf8'));
    return value.version === 1 && Array.isArray(value.tails) && Array.isArray(value.seen) ? value : null;
  } catch { return null; }
}
export async function saveCheckpoint(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.next`;
  await writeFile(temporary, await compress(JSON.stringify(value), { level: 1 }), { mode: 0o600 });
  await rename(temporary, path);
}
