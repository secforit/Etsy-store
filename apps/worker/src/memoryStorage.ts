/** In-memory BlobStorage for the demo (nothing written to disk). Same key rules as the real storage. */
import type { BlobStorage } from '@etsy-agents/core/integrations/types.ts';

export class InMemoryBlobStorage implements BlobStorage {
  private readonly blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  private check(key: string): void {
    if (typeof key !== 'string' || !/^[a-z0-9_.-][a-z0-9/_.-]{0,511}$/.test(key) || key.includes('..') || key.includes('//')) {
      throw new Error('invalid blob key');
    }
  }

  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    this.check(key);
    this.blobs.set(key, { bytes: new Uint8Array(bytes), mimeType });
  }

  async get(key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    this.check(key);
    return this.blobs.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.check(key);
    this.blobs.delete(key);
  }

  get size(): number {
    return this.blobs.size;
  }
}
