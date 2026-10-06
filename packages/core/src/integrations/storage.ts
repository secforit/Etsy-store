/**
 * Blob storage (security rule 7): keys are `[a-z0-9/_.-]` only, no `..`, no leading `/`, no empty or hidden
 * (dot-prefixed) segments. The filesystem implementation resolves every key inside its root, re-checks the real
 * path (symlinks) before reading or writing, writes atomically, and keeps the MIME type in a side file under
 * `<root>/.meta/` (unreachable by keys because dot-segments are rejected).
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BlobStorage } from './types.ts';

export class BlobKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobKeyError';
  }
}

const KEY_CHARS = /^[a-z0-9/_.-]+$/;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
export const MAX_KEY_LENGTH = 512;

/** Throws BlobKeyError for anything that is not a safe relative key. Returns the key unchanged. */
export function validateBlobKey(key: unknown): string {
  if (typeof key !== 'string') throw new BlobKeyError('blob key must be a string');
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) throw new BlobKeyError('blob key length out of range');
  if (!KEY_CHARS.test(key)) throw new BlobKeyError('blob key has characters outside [a-z0-9/_.-]');
  if (key.startsWith('/')) throw new BlobKeyError('blob key must be relative');
  if (key.includes('..')) throw new BlobKeyError("blob key must not contain '..'");
  if (key.endsWith('/')) throw new BlobKeyError('blob key must name a file');
  for (const seg of key.split('/')) {
    if (seg === '') throw new BlobKeyError('blob key has an empty segment');
    if (seg.startsWith('.')) throw new BlobKeyError('blob key segments must not start with a dot');
  }
  return key;
}

function validateMime(mimeType: string): string {
  const m = mimeType.trim().toLowerCase();
  if (m.length > 100 || !MIME_RE.test(m)) throw new Error('invalid mime type');
  return m;
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
};

function mimeFromKey(key: string): string {
  const ext = key.split('.').pop() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

function isInside(root: string, candidate: string): boolean {
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
  const tmp = path.join(path.dirname(target), `.${randomBytes(12).toString('hex')}.part`);
  await fs.writeFile(tmp, bytes, { mode: 0o640, flag: 'wx' });
  try {
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export class FileBlobStorage implements BlobStorage {
  readonly root: string;
  private realRoot: Promise<string> | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private async getRealRoot(): Promise<string> {
    if (!this.realRoot) {
      this.realRoot = (async () => {
        await fs.mkdir(this.root, { recursive: true, mode: 0o750 });
        return fs.realpath(this.root);
      })();
      this.realRoot.catch(() => {
        this.realRoot = null;
      });
    }
    return this.realRoot;
  }

  /** Lexical resolution inside the root (no I/O). */
  resolveKey(key: string): string {
    validateBlobKey(key);
    const full = path.resolve(this.root, key);
    if (!isInside(this.root, full)) throw new BlobKeyError('blob key escapes the storage root');
    return full;
  }

  private metaPath(key: string): string {
    return path.join(this.root, '.meta', `${key}.json`);
  }

  /** Ensures the real (symlink-resolved) directory of `full` is inside the real root. */
  private async assertRealParentInside(full: string): Promise<void> {
    const realRoot = await this.getRealRoot();
    const realParent = await fs.realpath(path.dirname(full));
    if (realParent !== realRoot && !isInside(realRoot, realParent))
      throw new BlobKeyError('blob key escapes the storage root');
  }

  /**
   * Creates `dir` one segment at a time, refusing to traverse a symlink that leaves the root
   * (a recursive mkdir would follow it and create directories outside before any check).
   */
  private async mkdirInside(dir: string): Promise<void> {
    const realRoot = await this.getRealRoot();
    const rel = path.relative(this.root, dir);
    if (rel === '') return;
    let current = this.root;
    for (const seg of rel.split(path.sep)) {
      current = path.join(current, seg);
      const st = await fs.lstat(current).catch((e: unknown) => (isNotFound(e) ? null : Promise.reject(e)));
      if (!st) {
        await fs.mkdir(current, { mode: 0o750 }).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e;
        });
        continue;
      }
      if (st.isSymbolicLink()) {
        const real = await fs.realpath(current);
        if (real !== realRoot && !isInside(realRoot, real)) throw new BlobKeyError('blob key escapes the storage root');
      } else if (!st.isDirectory()) {
        throw new BlobKeyError('blob key path crosses a non-directory');
      }
    }
  }

  private async assertRealFileInside(full: string): Promise<void> {
    const realRoot = await this.getRealRoot();
    const real = await fs.realpath(full);
    if (!isInside(realRoot, real)) throw new BlobKeyError('blob key escapes the storage root');
  }

  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const full = this.resolveKey(key);
    const mime = validateMime(mimeType);
    await this.mkdirInside(path.dirname(full));
    await this.assertRealParentInside(full);
    // Refuse to overwrite through a symlink planted at the target path.
    const existing = await fs.lstat(full).catch((e: unknown) => (isNotFound(e) ? null : Promise.reject(e)));
    if (existing && !existing.isFile()) throw new BlobKeyError('blob key points to a non-regular file');

    // Temp files live next to their target (same filesystem, so rename is atomic); dot-names are never keys.
    await atomicWrite(full, bytes);
    const meta = this.metaPath(key);
    await this.mkdirInside(path.dirname(meta));
    await atomicWrite(meta, new TextEncoder().encode(JSON.stringify({ mimeType: mime, size: bytes.byteLength })));
  }

  async get(key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const full = this.resolveKey(key);
    try {
      await this.assertRealFileInside(full);
      const stat = await fs.stat(full);
      if (!stat.isFile()) return null;
      const buf = await fs.readFile(full);
      let mimeType = mimeFromKey(key);
      try {
        const meta = JSON.parse(await fs.readFile(this.metaPath(key), 'utf8')) as { mimeType?: unknown };
        if (typeof meta.mimeType === 'string') mimeType = validateMime(meta.mimeType);
      } catch {
        // missing/invalid meta: fall back to the extension
      }
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), mimeType };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const full = this.resolveKey(key);
    try {
      await this.assertRealParentInside(full);
    } catch (e) {
      if (isNotFound(e)) return;
      throw e;
    }
    await fs.rm(full, { force: true });
    await fs.rm(this.metaPath(key), { force: true });
  }
}

/** In-memory storage with the same key rules (tests, demos without a disk). */
export class MemoryBlobStorage implements BlobStorage {
  private readonly items = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    validateBlobKey(key);
    this.items.set(key, { bytes: new Uint8Array(bytes), mimeType: validateMime(mimeType) });
  }

  async get(key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    validateBlobKey(key);
    const item = this.items.get(key);
    return item ? { bytes: new Uint8Array(item.bytes), mimeType: item.mimeType } : null;
  }

  async delete(key: string): Promise<void> {
    validateBlobKey(key);
    this.items.delete(key);
  }

  keys(): string[] {
    return [...this.items.keys()].sort();
  }
}
