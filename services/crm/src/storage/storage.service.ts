import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Readable } from 'stream';
import {
  LocalDiskStorageDriver,
  S3StorageDriver,
  VercelBlobStorageDriver,
  buildClientUploadTarget,
  generateClientUploadToken,
  resolveBlobAccess,
  resolveLocalStorageRoot,
  resolveVercelBlobConfig,
  resolveStorageDriverMode,
  type ObjectStream,
  type RangedObjectStream,
  type ClientUploadTarget,
  type StorageDriver,
} from '@trinity/storage';

export type { ObjectStream, RangedObjectStream, ClientUploadTarget };

// Nhánh S3/MinIO CHỈ dùng khi STORAGE_DRIVER=s3 (đường quay lại).
// Env giữ nguyên tên cũ để không phá cấu hình nào từng dùng MinIO thật.
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? '';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? '';
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'trinity-documents';
const MINIO_REGION = process.env.MINIO_REGION ?? 'ap-southeast-1';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly driverMode = resolveStorageDriverMode();
  private readonly driver: StorageDriver = this.buildDriver();

  private buildDriver(): StorageDriver {
    const logger = { warn: (m: string) => this.logger.warn(m) };
    if (this.driverMode === 's3') {
      return new S3StorageDriver(
        {
          endpoint: MINIO_ENDPOINT,
          region: MINIO_REGION,
          accessKeyId: MINIO_ACCESS_KEY,
          secretAccessKey: MINIO_SECRET_KEY,
          bucket: MINIO_BUCKET,
        },
        logger,
      );
    }
    // Vercel serverless — đĩa không bền, file nằm trên Vercel Blob (REST).
    if (this.driverMode === 'vercel-blob') {
      return new VercelBlobStorageDriver(resolveVercelBlobConfig(), logger);
    }
    return new LocalDiskStorageDriver(resolveLocalStorageRoot(), logger);
  }

  /**
   * `STORAGE_DRIVER=local` (mặc định): `mkdir -p` + kiểm quyền ghi thật (ghi thử
   * 1 byte rồi xoá). LỖI Ở ĐÂY LÀ LOUD — throw để crash boot ngay, KHÔNG đợi
   * tới lúc user upload mới phát hiện thiếu quyền ghi `STORAGE_LOCAL_ROOT`.
   *
   * `STORAGE_DRIVER=s3` giữ hành vi cũ (graceful — chỉ log warn, không chặn boot)
   * vì đây là đường quay lại tuỳ chọn, không phải cấu hình mặc định.
   */
  async onModuleInit() {
    try {
      await this.driver.init();
      this.logger.log(`Storage driver '${this.driverMode}' sẵn sàng`);
    } catch (err) {
      if (this.driverMode === 'local') {
        throw err;
      }
      this.logger.warn(`Không thể xác thực storage driver: ${(err as Error).message}`);
    }
  }

  /**
   * Upload file. `body` chấp nhận `Buffer` (payload nhỏ trong RAM) hoặc
   * `Readable` (file lớn — vd video đọc từ diskStorage, xem
   * `newsfeed.service.ts uploadVideo()`). Khi truyền stream, LUÔN kèm
   * `contentLength` (= `file.size` từ multer) để driver stream trực tiếp
   * thay vì phải buffer toàn bộ vào RAM (trần video, OOM).
   */
  async upload(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    contentLength?: number,
  ): Promise<string> {
    const result = await this.driver.upload(key, body, contentType, contentLength);
    this.logger.log(`Uploaded: ${key}`);
    return result;
  }

  /**
   * Presigned GET URL. CHỈ hoạt động ở `STORAGE_DRIVER=s3` — đĩa cục bộ không
   * có khái niệm này, driver ném `PresignNotSupportedError`.
   */
  async getPresignedUrl(key: string): Promise<string> {
    return this.driver.getPresignedUrl(key);
  }

  /**
   * Đọc object dạng stream để proxy nội dung qua backend — dùng khi client
   * không (hoặc không nên) truy cập trực tiếp storage backend.
   */
  async getObjectStream(key: string): Promise<ObjectStream> {
    return this.driver.getObjectStream(key);
  }

  /**
   * Đọc object hỗ trợ HTTP Range requests (RFC 7233) — cần cho `<video>`/`<audio>`
   * HTML5 seek.
   */
  async getObjectStreamRange(
    key: string,
    range?: string,
  ): Promise<RangedObjectStream> {
    return this.driver.getObjectStreamRange(key, range);
  }

  /**
   * Vercel giới hạn body function 4,5 MB nên file lớn (video Newsfeed ≤40MB) phải được
   * trình duyệt PUT THẲNG lên Blob. Chỉ `STORAGE_DRIVER=vercel-blob` hỗ trợ; driver khác → `false`
   * (FE rơi về multipart cũ qua BE).
   */
  isClientUploadSupported(): boolean {
    return this.driverMode === 'vercel-blob';
  }

  /** Token + URL để trình duyệt tự upload đúng `key`, đúng loại, ≤ `maxBytes` (hết hạn sau 15 phút). */
  createClientUpload(key: string, contentType: string, maxBytes: number): ClientUploadTarget {
    if (!this.isClientUploadSupported()) {
      throw new Error('Client upload chỉ hỗ trợ ở STORAGE_DRIVER=vercel-blob');
    }
    const { token } = resolveVercelBlobConfig();
    const clientToken = generateClientUploadToken({
      token,
      pathname: key,
      maximumSizeInBytes: maxBytes,
      allowedContentTypes: [contentType],
    });
    return buildClientUploadTarget(clientToken, key, contentType, resolveBlobAccess());
  }

  /** Best-effort delete; logs warning nếu lỗi (vd đã xoá từ trước). */
  async delete(key: string): Promise<void> {
    await this.driver.delete(key);
    this.logger.log(`Deleted: ${key}`);
  }
}
