import type { Readable } from 'node:stream';

/** Kết quả đọc 1 object dạng stream — dùng để proxy nội dung qua backend. */
export interface ObjectStream {
  body: Readable;
  contentType: string;
  contentLength?: number;
}

/** Kết quả đọc object có hỗ trợ HTTP Range (RFC 7233) — cần cho `<video>`/`<audio>` seek. */
export interface RangedObjectStream extends ObjectStream {
  /** 206 khi Range request hợp lệ được phục vụ, 200 khi trả full object */
  statusCode: 200 | 206;
  /** Giá trị header `Content-Range` khi statusCode=206 (vd `bytes 0-999/50000`) */
  contentRange?: string;
}

/**
 * Interface chung cho mọi driver lưu trữ file; mặc định lưu đĩa cục bộ (không cần
 * dịch vụ object storage riêng).
 *
 * `getPresignedUrl` là điểm khác BẢN CHẤT giữa 2 driver: S3/MinIO có URL chữ ký
 * tạm thời phục vụ trực tiếp cho browser; đĩa cục bộ KHÔNG CÓ khái niệm này —
 * `LocalDiskStorageDriver.getPresignedUrl()` throw loud, caller phải chuyển
 * sang streaming qua backend (`getObjectStream`/`getObjectStreamRange`).
 */
export interface StorageDriver {
  /**
   * Khởi tạo driver — S3: kiểm/tạo bucket. Local: `mkdir -p` root + kiểm quyền
   * ghi thật (ghi thử 1 byte rồi xoá). Gọi 1 lần lúc boot; lỗi ở đây là lỗi
   * cấu hình hạ tầng, PHẢI được caller coi là LOUD (xem `StorageService.onModuleInit`).
   */
  init(): Promise<void>;

  /**
   * Upload file. `body` là `Buffer` (payload nhỏ trong RAM) hoặc `Readable`
   * (file lớn đọc từ đĩa/tmp — LUÔN kèm `contentLength` khi biết trước để
   * driver stream thẳng, không phải buffer toàn bộ vào RAM để đo kích thước —
   * tránh hết bộ nhớ với file lớn).
   */
  upload(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    contentLength?: number,
  ): Promise<string>;

  /** Presigned GET URL — CHỈ driver S3 hỗ trợ thật. */
  getPresignedUrl(key: string): Promise<string>;

  /** Đọc object dạng stream để proxy qua backend. */
  getObjectStream(key: string): Promise<ObjectStream>;

  /** Đọc object hỗ trợ HTTP Range — `range` là giá trị thô của header `Range`. */
  getObjectStreamRange(key: string, range?: string): Promise<RangedObjectStream>;

  /** Best-effort delete — KHÔNG throw khi object không tồn tại. */
  delete(key: string): Promise<void>;
}

/**
 * Ném khi object không tồn tại. `name = 'NoSuchKey'` CỐ Ý khớp với error name
 * mà AWS SDK v3 ném cho S3 — nhiều caller
 * duck-type `err.name === 'NoSuchKey' || err.name === 'NotFound'`
 * để phân biệt "chưa cache"/"đã xoá" với lỗi thật; giữ đúng shape này để đổi driver
 * không phải sửa caller.
 */
export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'NoSuchKey';
  }
}

/** Ném khi key vi phạm path traversal / null byte / đường dẫn tuyệt đối. */
export class StorageInvalidKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`Key không hợp lệ (${reason}): ${JSON.stringify(key)}`);
    this.name = 'StorageInvalidKeyError';
  }
}

/** Ném khi gọi `getPresignedUrl` trên driver không hỗ trợ (đĩa cục bộ). */
export class PresignNotSupportedError extends Error {
  constructor() {
    super(
      'getPresignedUrl không được hỗ trợ ở driver hiện tại (STORAGE_DRIVER=local) — ' +
        'dùng getObjectStream/getObjectStreamRange để stream qua backend thay vì URL chữ ký trực tiếp.',
    );
    this.name = 'PresignNotSupportedError';
  }
}

/** Logger tối giản, framework-agnostic — cả NestJS Logger lẫn console đều khớp shape này. */
export interface MinimalLogger {
  warn(message: string): void;
}
