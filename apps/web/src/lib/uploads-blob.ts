/**
 * Đọc `/uploads/<…>` từ Vercel Blob. Trên Vercel không có đĩa bền, nên ảnh đại
 * diện/ảnh sản phẩm do BE lưu ở Blob key `uploads/<…>` (xem `@trinity/storage` `uploads-store`).
 * Hợp đồng đọc: `GET https://<storeId>.<access>.blob.vercel-storage.com/<key>` kèm
 * `authorization: Bearer <BLOB_READ_WRITE_TOKEN>` (cần cho store private, vô hại với public).
 * Chỉ dùng env — web không import `@trinity/storage` để khỏi thêm dependency.
 */
export function isBlobUploadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STORAGE_DRIVER === 'vercel-blob' && !!env.BLOB_READ_WRITE_TOKEN?.trim();
}

/** `segments` đã được route kiểm không chứa `..`/`/`/rỗng. */
export function buildBlobUploadUrl(
  segments: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  const storeId = token?.split('_')[3];
  if (!token || !storeId) return null;
  const access = env.BLOB_ACCESS === 'private' ? 'private' : 'public';
  const key = ['uploads', ...segments].map(encodeURIComponent).join('/');
  return `https://${storeId}.${access}.blob.vercel-storage.com/${key}`;
}
