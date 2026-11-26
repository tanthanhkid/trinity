export type StorageDriverMode = 'local' | 's3';

const DEFAULT_LOCAL_ROOT = '/var/lib/trinity/storage';

/**
 * `STORAGE_DRIVER` — mặc định `'local'` (đĩa cục bộ, không cần MinIO). `s3` là giá trị còn lại;
 * mọi giá trị khác (kể cả rỗng/không set) → `'local'`, KHÔNG throw — driver mặc định phải AN TOÀN khi thiếu cấu hình.
 */
export function resolveStorageDriverMode(): StorageDriverMode {
  return process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local';
}

/** `STORAGE_LOCAL_ROOT` — mặc định `/var/lib/trinity/storage`. */
export function resolveLocalStorageRoot(): string {
  const raw = process.env.STORAGE_LOCAL_ROOT;
  if (raw && raw.trim().length > 0) return raw.trim();
  return DEFAULT_LOCAL_ROOT;
}
