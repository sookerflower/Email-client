import { isNodeRuntime } from './runtime';
import { env } from '../env';

/**
 * Thread-body blob storage (Phase 2 of MIGRATION-PLAN.md §6, replaces R2
 * THREADS_BUCKET). Stores parsed thread JSON, one object per thread, keyed
 * `{connectionId}/{threadId}.json`. Contents are rebuildable from the IMAP
 * server on miss, so losing a blob costs a re-sync, never data.
 *
 * On Node: files under DATA_DIR (default ./data/threads). On workerd: the R2
 * bucket, unchanged (deleted with the rest of the wrangler config at
 * cutover). The interface is S3-compatible-shaped so a MinIO impl can slot in
 * if this ever goes multi-node.
 */
export interface BlobStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

class FsBlobStore implements BlobStore {
  constructor(private baseDir: string) {}

  // Keys are `${connectionId}/${threadId}.json` where both ids are
  // app-generated (UUIDs / driver-encoded ids); sanitize anyway so a
  // malformed id can never escape the base directory.
  private pathFor(key: string) {
    const safe = key
      .split('/')
      .map((part) => part.replace(/[^A-Za-z0-9._@=-]/g, '_'))
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/');
    return `${this.baseDir}/${safe}`;
  }

  async get(key: string): Promise<string | null> {
    const { readFile } = await import('node:fs/promises');
    try {
      return await readFile(this.pathFor(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const { writeFile, mkdir, rename } = await import('node:fs/promises');
    const path = this.pathFor(key);
    const dir = path.slice(0, path.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a torn blob.
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, value, 'utf8');
    await rename(tmp, path);
  }

  async delete(key: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.pathFor(key), { force: true });
  }
}

class R2BlobStore implements BlobStore {
  async get(key: string): Promise<string | null> {
    const object = await env.THREADS_BUCKET.get(key);
    if (!object) return null;
    return await object.text();
  }

  async put(key: string, value: string): Promise<void> {
    await env.THREADS_BUCKET.put(key, value);
  }

  async delete(key: string): Promise<void> {
    await env.THREADS_BUCKET.delete(key);
  }
}

let cached: BlobStore | null = null;

export const getThreadBlobStore = (): BlobStore => {
  if (!cached) {
    cached = isNodeRuntime
      ? new FsBlobStore(`${process.env.DATA_DIR || './data'}/threads`)
      : new R2BlobStore();
  }
  return cached;
};

/** Canonical thread blob key — always with the `.json` suffix. */
export const threadBlobKey = (connectionId: string, threadId: string) =>
  `${connectionId}/${threadId}.json`;
