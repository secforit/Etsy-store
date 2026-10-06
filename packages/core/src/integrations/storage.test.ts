import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobKeyError, FileBlobStorage, MemoryBlobStorage, validateBlobKey } from './storage.ts';

const BAD_KEYS = [
  '',
  '../etc/passwd',
  'designs/../../etc/passwd',
  'designs/..',
  '..',
  'a..b/c.png',
  '/etc/passwd',
  'Designs/A.png',
  'designs\\..\\x',
  'designs/%2e%2e/x',
  'designs//x.png',
  'designs/x.png/',
  '.meta/designs/x.png.json',
  '.secrets/etsy-refresh-token.json',
  'designs/./x.png',
  'designs/.hidden',
  'désigns/x.png',
  'designs/x.png\u0000.txt',
  'designs/x y.png',
  'a'.repeat(513),
];

describe('validateBlobKey', () => {
  it('accepts normal keys', () => {
    for (const k of ['designs/p1/art-1.png', 'print/p_2/print.png', 'reports/2026-10-05.md', 'a']) expect(validateBlobKey(k)).toBe(k);
  });

  it.each(BAD_KEYS)('rejects %j', (key) => {
    expect(() => validateBlobKey(key)).toThrow(BlobKeyError);
  });

  it('rejects non-strings', () => {
    expect(() => validateBlobKey(undefined)).toThrow(BlobKeyError);
    expect(() => validateBlobKey(42)).toThrow(BlobKeyError);
  });
});

describe('FileBlobStorage', () => {
  let tmp: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'blobs-'));
    root = path.join(tmp, 'root');
    outside = path.join(tmp, 'outside');
    await fs.mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('round-trips bytes and mime type, and deletes', async () => {
    const s = new FileBlobStorage(root);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await s.put('designs/p1/art-1.png', bytes, 'image/png');
    expect(await s.get('designs/p1/art-1.png')).toEqual({ bytes, mimeType: 'image/png' });
    await s.put('designs/p1/art-1.png', new Uint8Array([9]), 'image/png');
    expect((await s.get('designs/p1/art-1.png'))!.bytes).toEqual(new Uint8Array([9]));
    await s.delete('designs/p1/art-1.png');
    expect(await s.get('designs/p1/art-1.png')).toBeNull();
    await s.delete('designs/p1/art-1.png'); // idempotent
    expect(await s.get('never/was.png')).toBeNull();
  });

  it('keeps the mime type outside the key space and leaves no temp files', async () => {
    const s = new FileBlobStorage(root);
    await s.put('reports/w1.md', new TextEncoder().encode('# hi'), 'text/markdown');
    const files = await fs.readdir(path.join(root, 'reports'));
    expect(files).toEqual(['w1.md']);
    expect((await s.get('reports/w1.md'))!.mimeType).toBe('text/markdown');
  });

  it('rejects invalid mime types', async () => {
    const s = new FileBlobStorage(root);
    await expect(s.put('a.png', new Uint8Array([1]), 'image/png\r\nx: y')).rejects.toThrow();
  });

  it.each(BAD_KEYS)('refuses traversal key %j for put/get/delete', async (key) => {
    const s = new FileBlobStorage(root);
    await expect(s.put(key, new Uint8Array([1]), 'image/png')).rejects.toThrow(BlobKeyError);
    await expect(s.get(key)).rejects.toThrow(BlobKeyError);
    await expect(s.delete(key)).rejects.toThrow(BlobKeyError);
  });

  it('refuses to write through a symlinked directory that leaves the root', async () => {
    const s = new FileBlobStorage(root);
    await s.put('seed.png', new Uint8Array([0]), 'image/png'); // creates root
    await fs.symlink(outside, path.join(root, 'designs'));
    await expect(s.put('designs/x.png', new Uint8Array([1]), 'image/png')).rejects.toThrow(BlobKeyError);
    await expect(s.put('designs/deeper/x.png', new Uint8Array([1]), 'image/png')).rejects.toThrow(BlobKeyError);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses to read or overwrite through a symlinked file', async () => {
    const s = new FileBlobStorage(root);
    await s.put('seed.png', new Uint8Array([0]), 'image/png');
    const secret = path.join(outside, 'secret.txt');
    await fs.writeFile(secret, 'top secret');
    await fs.symlink(secret, path.join(root, 'leak.png'));
    await expect(s.get('leak.png')).rejects.toThrow(BlobKeyError);
    await expect(s.put('leak.png', new Uint8Array([1]), 'image/png')).rejects.toThrow(BlobKeyError);
    expect(await fs.readFile(secret, 'utf8')).toBe('top secret');
  });

  it('allows symlinks that stay inside the root', async () => {
    const s = new FileBlobStorage(root);
    await s.put('real/a.png', new Uint8Array([5]), 'image/png');
    await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'));
    await s.put('alias/b.png', new Uint8Array([6]), 'image/png');
    expect((await s.get('real/b.png'))!.bytes).toEqual(new Uint8Array([6]));
  });
});

describe('MemoryBlobStorage', () => {
  it('applies the same key rules', async () => {
    const s = new MemoryBlobStorage();
    await s.put('designs/a.png', new Uint8Array([1]), 'image/png');
    expect(s.keys()).toEqual(['designs/a.png']);
    await expect(s.put('../a.png', new Uint8Array([1]), 'image/png')).rejects.toThrow(BlobKeyError);
    const got = await s.get('designs/a.png');
    got!.bytes[0] = 99; // returned copy must not alias storage
    expect((await s.get('designs/a.png'))!.bytes[0]).toBe(1);
    await s.delete('designs/a.png');
    expect(await s.get('designs/a.png')).toBeNull();
  });
});
