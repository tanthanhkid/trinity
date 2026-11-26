import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalDiskStorageDriver } from './local-disk-driver';
import { resolveSafeKey } from './path-safety';
import type { MinimalLogger } from './types';

/**
 * Kho "uploads" công khai-qua-URL cũ (`/uploads/avatars/…`, `/uploads/products/…`).
 * URL lưu trong DB GIỮ NGUYÊN dạng `/uploads/<thư mục>/<tên>`; file nằm trên đĩa `UPLOADS_LOCAL_ROOT`
 * hoặc `<cwd>/uploads` (monolith `useStaticAssets` phục vụ).
 */
export const UPLOADS_URL_PREFIX = '/uploads/';

export interface UploadsStore {
  /** `relPath` dạng `avatars/1_123.jpg` (không có `/uploads/` đầu). */
  save(relPath: string, body: Buffer, contentType: string): Promise<void>;
  /** Best-effort, không throw. Trả `true` nếu chắc chắn đã xoá. */
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

/** `localRoot`: thư mục gốc (vd `EMPLOYEE_AVATAR_DIR` cũ, hoặc test). */
export function createUploadsStore(
  opts: { localRoot?: string; logger?: MinimalLogger } = {},
): UploadsStore {
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
