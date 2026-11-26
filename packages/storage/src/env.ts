export type StorageDriverMode = 'local' | 's3';

const DEFAULT_LOCAL_ROOT = '/var/lib/trinity/storage';

/**
 * `STORAGE_DRIVER` — mặc định `'local'` (đĩa cục bộ, không cần MinIO). `s3` là giá trị còn lại;
 * mọi giá trị khác (kể cả rỗng/không set) → `'local'`, KHÔNG throw — driver mặc định phải AN TOÀN khi thiếu cấu hình.
 */
export function resolveStorageDriverMode(): StorageDriverMode {
  const v = process.env.STORAGE_DRIVER?.trim();
  // Driver Blob đã gỡ: KHÔNG được âm thầm rơi về đĩa (tệp cũ nằm trên Blob sẽ "biến mất", tệp mới ghi vào chỗ khác).
  if (v === 'vercel-blob' || (!v && process.env.BLOB_READ_WRITE_TOKEN?.trim())) {
    throw new Error(BLOB_REMOVED_MESSAGE);
  }
  return v === 's3' ? 's3' : 'local';
}

/** Lỗi khởi động khi cấu hình còn trỏ vào driver Blob đã gỡ — kèm cách chuyển dữ liệu. */
export const BLOB_REMOVED_MESSAGE =
  'STORAGE_DRIVER=vercel-blob (hoặc BLOB_READ_WRITE_TOKEN không kèm STORAGE_DRIVER) không còn được hỗ trợ. ' +
  'Chuyển tệp ra khỏi Blob store trước: khoá `uploads/<đường dẫn>` → `<UPLOADS_LOCAL_ROOT>/<đường dẫn>`, mọi khoá khác → ' +
  '`<STORAGE_LOCAL_ROOT>/<khoá>` (hoặc chép nguyên khoá sang bucket S3 và đặt STORAGE_DRIVER=s3). ' +
  'Sau đó đặt STORAGE_DRIVER=local|s3 và xoá BLOB_READ_WRITE_TOKEN. Xem docs/deployment.md, mục "Moving files off Blob storage".';

/** `STORAGE_LOCAL_ROOT` — mặc định `/var/lib/trinity/storage`. */
export function resolveLocalStorageRoot(): string {
  const raw = process.env.STORAGE_LOCAL_ROOT;
  if (raw && raw.trim().length > 0) return raw.trim();
  return DEFAULT_LOCAL_ROOT;
}
