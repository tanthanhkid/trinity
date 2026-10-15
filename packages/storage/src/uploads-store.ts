import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalDiskStorageDriver } from './local-disk-driver';
import { resolveSafeKey } from './path-safety';
import { resolveStorageDriverMode, resolveVercelBlobConfig } from './env';
import { VercelBlobStorageDriver } from './vercel-blob-driver';
import type { MinimalLogger, StorageDriver } from './types';

/**
 * Kho "uploads" công khai-qua-URL cũ (`/uploads/avatars/…`, `/uploads/products/…`).
 * URL lưu trong DB GIỮ NGUYÊN dạng `/uploads/<thư mục>/<tên>`; chỉ nơi lưu đổi:
 *  - Mặc định (local/s3): đĩa `UPLOADS_LOCAL_ROOT` hoặc `<cwd>/uploads` — y hệt
 *    hành vi khi chạy server thường (monolith `useStaticAssets` vẫn phục vụ).
 *  - `STORAGE_DRIVER=vercel-blob`: Blob, key `uploads/<thư mục>/<tên>`; web route
 *    `app/uploads/[...path]` đọc lại từ Blob.
 */
export const UPLOADS_URL_PREFIX = '/uploads/';
export const UPLOADS_BLOB_KEY_PREFIX = 'uploads/';

export interface UploadsStore {
  /** `relPath` dạng `avatars/1_123.jpg` (không có `/uploads/` đầu). */
  save(relPath: string, body: Buffer, contentType: string): Promise<void>;
  /** Best-effort, không throw. Trả `true` nếu chắc chắn đã xoá (local) / đã gửi lệnh (blob). */
  remove(relPath: string): Promise<boolean>;
}

class LocalUploadsStore implements UploadsStore {
  constructor(private readonly root: string) {}

  async save(relPath: string, body: Buffer): Promise<void> {
    const target = resolveSafeKey(this.root, relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async remove(relPath: string): Promise<boolean> {
    try {
      await unlink(resolveSafeKey(this.root, relPath));
      return true;
    } catch {
      return false;
    }
  }
}

class DriverUploadsStore implements UploadsStore {
  constructor(private readonly driver: StorageDriver) {}

  async save(relPath: string, body: Buffer, contentType: string): Promise<void> {
    await this.driver.upload(UPLOADS_BLOB_KEY_PREFIX + relPath, body, contentType);
  }

  async remove(relPath: string): Promise<boolean> {
    await this.driver.delete(UPLOADS_BLOB_KEY_PREFIX + relPath);
    return true;
  }
}

/** `root` chỉ áp dụng nhánh đĩa (vd `EMPLOYEE_AVATAR_DIR` cũ, hoặc test). */
export function createUploadsStore(
  opts: { localRoot?: string; logger?: MinimalLogger } = {},
): UploadsStore {
  if (resolveStorageDriverMode() === 'vercel-blob') {
    return new DriverUploadsStore(
      new VercelBlobStorageDriver(resolveVercelBlobConfig(), opts.logger),
    );
  }
  const root =
    opts.localRoot ?? process.env.UPLOADS_LOCAL_ROOT?.trim() ?? join(process.cwd(), 'uploads');
  return new LocalUploadsStore(root || join(process.cwd(), 'uploads'));
}

/** `/uploads/avatars/x.jpg` → `avatars/x.jpg`; không đúng dạng/có `..` → `null`. */
export function uploadsRelPathFromUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(UPLOADS_URL_PREFIX)) return null;
  const rel = url.slice(UPLOADS_URL_PREFIX.length);
  if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('//')) return null;
  return rel;
}
