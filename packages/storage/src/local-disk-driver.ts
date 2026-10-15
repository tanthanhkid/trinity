import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { writeAtomic } from './atomic-write';
import { resolveSafeKey } from './path-safety';
import { parseRange } from './range';
import {
  type MinimalLogger,
  type ObjectStream,
  type RangedObjectStream,
  type StorageDriver,
  StorageObjectNotFoundError,
  PresignNotSupportedError,
} from './types';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

interface ObjectMeta {
  contentType: string;
}

function metaPathFor(diskPath: string): string {
  return `${diskPath}.meta.json`;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Driver lưu file trên đĩa cục bộ — thay thế object storage khi tự host.
 *
 * Bố cục trên đĩa: `${root}/${key}` cho nội dung + `${root}/${key}.meta.json`
 * (chỉ chứa `{contentType}`) — content-type KHÔNG suy được từ phần mở rộng file
 * một cách đáng tin cậy (nhiều key không có đuôi, vd `voice/2026-.../id`
 * có thể không có đuôi trong khi `documents/a.pdf` thì có), nên lưu tường minh để round-trip
 * CHÍNH XÁC như S3 (nơi Content-Type là metadata thật của object).
 *
 * An toàn: MỌI key đi qua `resolveSafeKey` (path traversal / null byte / path
 * tuyệt đối) trước khi chạm hệ thống file — xem `path-safety.ts`.
 */
export class LocalDiskStorageDriver implements StorageDriver {
  constructor(
    private readonly root: string,
    private readonly logger: MinimalLogger = { warn: () => undefined },
  ) {}

  /**
   * `mkdir -p` root + kiểm quyền ghi THẬT (ghi thử 1 byte rồi xoá). Throw loud
   * khi thiếu quyền — caller (`StorageService.onModuleInit`) PHẢI để lỗi này
   * làm crash boot, không đợi tới lúc user upload mới phát hiện.
   */
  async init(): Promise<void> {
    const probePath = join(this.root, `.write-test-${randomBytes(6).toString('hex')}`);
    try {
      await mkdir(this.root, { recursive: true });
      await writeAtomic(probePath, Buffer.from('1'));
    } catch (err) {
      throw new Error(
        `STORAGE_LOCAL_ROOT '${this.root}' không ghi được — kiểm tra quyền sở hữu/thư mục ` +
          `(chown/mkdir trước khi khởi động service). Lỗi gốc: ${(err as Error).message}`,
      );
    } finally {
      await unlink(probePath).catch(() => undefined);
    }
  }

  async upload(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    contentLength?: number,
  ): Promise<string> {
    const diskPath = resolveSafeKey(this.root, key);
    const bytesWritten = await writeAtomic(diskPath, body);
    // Ghi meta SAU khi content đã rename thành công — 1 request đọc giữa lúc
    // content có mà meta chưa có sẽ fallback DEFAULT_CONTENT_TYPE (an toàn hơn
    // ngược lại: meta có mà content chưa có = 404 sai lệch).
    const meta: ObjectMeta = { contentType };
    await writeAtomic(metaPathFor(diskPath), Buffer.from(JSON.stringify(meta)));
    void contentLength; // giữ tham số cho khớp interface — driver tự đếm byte thật, không tin số caller truyền
    void bytesWritten;
    return key;
  }

  async getObjectStream(key: string): Promise<ObjectStream> {
    const diskPath = resolveSafeKey(this.root, key);
    const stats = await stat(diskPath).catch((err) => {
      if (isEnoent(err)) throw new StorageObjectNotFoundError(key);
      throw err;
    });
    const contentType = await this.readContentType(diskPath);
    return {
      body: createReadStream(diskPath),
      contentType,
      contentLength: stats.size,
    };
  }

  async getObjectStreamRange(
    key: string,
    range?: string,
  ): Promise<RangedObjectStream> {
    const diskPath = resolveSafeKey(this.root, key);
    const stats = await stat(diskPath).catch((err) => {
      if (isEnoent(err)) throw new StorageObjectNotFoundError(key);
      throw err;
    });
    const contentType = await this.readContentType(diskPath);
    const parsed = parseRange(range, stats.size);

    if (!parsed) {
      return {
        body: createReadStream(diskPath),
        contentType,
        contentLength: stats.size,
        statusCode: 200,
      };
    }

    const { start, end } = parsed;
    return {
      body: createReadStream(diskPath, { start, end }),
      contentType,
      contentLength: end - start + 1,
      statusCode: 206,
      contentRange: `bytes ${start}-${end}/${stats.size}`,
    };
  }

  /** Best-effort delete; logs warning nếu lỗi (khác ENOENT — đã xoá thì thôi). */
  async delete(key: string): Promise<void> {
    const diskPath = resolveSafeKey(this.root, key);
    await unlink(diskPath).catch((err) => {
      if (!isEnoent(err)) {
        this.logger.warn(`Could not delete object ${key}: ${(err as Error).message}`);
      }
    });
    await unlink(metaPathFor(diskPath)).catch(() => undefined);
  }

  /** Đĩa cục bộ KHÔNG có khái niệm presigned URL — throw loud. */
  async getPresignedUrl(_key: string): Promise<string> {
    void _key;
    throw new PresignNotSupportedError();
  }

  private async readContentType(diskPath: string): Promise<string> {
    try {
      const raw = await readFile(metaPathFor(diskPath), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ObjectMeta>;
      return typeof parsed.contentType === 'string' && parsed.contentType.length > 0
        ? parsed.contentType
        : DEFAULT_CONTENT_TYPE;
    } catch {
      return DEFAULT_CONTENT_TYPE;
    }
  }
}
