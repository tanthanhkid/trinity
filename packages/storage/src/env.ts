import type { BlobAccess, VercelBlobDriverConfig } from './vercel-blob-driver';

export type StorageDriverMode = 'local' | 's3' | 'vercel-blob';

const DEFAULT_LOCAL_ROOT = '/var/lib/trinity/storage';

/**
 * `STORAGE_DRIVER` — mặc định `'local'` (đĩa cục bộ, không cần MinIO). `s3` / `vercel-blob`
 * là 2 giá trị còn lại; mọi giá trị khác (kể cả rỗng/không set) → `'local'`,
 * KHÔNG throw — driver mặc định phải AN TOÀN khi thiếu cấu hình.
 */
export function resolveStorageDriverMode(): StorageDriverMode {
  const v = process.env.STORAGE_DRIVER;
  if (v === 's3' || v === 'vercel-blob') return v;
  // On Vercel a Blob store token implies the Blob driver, so connecting a Blob store is enough.
  if (!v && process.env.VERCEL === '1' && process.env.BLOB_READ_WRITE_TOKEN?.trim()) return 'vercel-blob';
  return 'local';
}

/** `STORAGE_LOCAL_ROOT` — mặc định `/var/lib/trinity/storage`. */
export function resolveLocalStorageRoot(): string {
  const raw = process.env.STORAGE_LOCAL_ROOT;
  if (raw && raw.trim().length > 0) return raw.trim();
  // Vercel functions have no writable persistent disk: fall back to the (ephemeral) temp dir so the app still boots.
  // Uploaded files will NOT survive; connect a Blob store (BLOB_READ_WRITE_TOKEN) or set STORAGE_DRIVER=s3 for real storage.
  if (process.env.VERCEL === '1') return '/tmp/trinity-storage';
  return DEFAULT_LOCAL_ROOT;
}

/** `BLOB_ACCESS=public|private` (mặc định `public`) — phải khớp loại Blob store. */
export function resolveBlobAccess(): BlobAccess {
  return process.env.BLOB_ACCESS === 'private' ? 'private' : 'public';
}

/** Cấu hình driver Vercel Blob từ env. Thiếu token → throw LOUD. */
export function resolveVercelBlobConfig(): VercelBlobDriverConfig {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    throw new Error('STORAGE_DRIVER=vercel-blob nhưng thiếu BLOB_READ_WRITE_TOKEN');
  }
  return { token, access: resolveBlobAccess() };
}
