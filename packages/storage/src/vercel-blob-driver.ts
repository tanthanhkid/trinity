import { Readable } from 'node:stream';
import {
  StorageInvalidKeyError,
  StorageObjectNotFoundError,
  PresignNotSupportedError,
  type MinimalLogger,
  type ObjectStream,
  type RangedObjectStream,
  type StorageDriver,
} from './types';

/**
 * Driver Vercel Blob bằng REST API + `fetch` — KHÔNG phụ thuộc
 * `@vercel/blob` (lockfile không được đụng). Hợp đồng REST lấy từ mã nguồn SDK
 * `@vercel/blob@2.8.0` (`src/api.ts`, `src/put.ts`, `src/del.ts`, `src/head.ts`), vì Vercel không công bố tài liệu REST riêng:
 *  - Ghi:  `PUT  {api}/?pathname=<key>`   header `authorization: Bearer <rw-token>`,
 *          `x-api-version`, `x-vercel-blob-access`, `x-content-type`,
 *          `x-add-random-suffix: 0`, `x-allow-overwrite: 1`, `x-content-length`.
 *  - Xoá:  `POST {api}/delete`            body JSON `{ urls: [...] }`.
 *  - Đọc:  `GET  https://<storeId>.<access>.blob.vercel-storage.com/<key>`
 *          (store private cần `authorization: Bearer <rw-token>`; gửi luôn cả public
 *          cũng vô hại). `storeId` = phần thứ 4 của token `vercel_blob_rw_<storeId>_<…>`.
 * Key = pathname, nên cùng namespace `documents/…`, `newsfeed/…`
 * với driver đĩa/S3 — đổi driver không đổi key lưu trong DB.
 */
export type BlobAccess = 'public' | 'private';

export interface VercelBlobDriverConfig {
  /** `BLOB_READ_WRITE_TOKEN` (`vercel_blob_rw_<storeId>_<secret>`). */
  token: string;
  /** Loại store — mặc định `public`. Phải khớp loại store đã tạo trên Vercel. */
  access?: BlobAccess;
  /** Ghi đè API base (test/proxy) — mặc định `https://vercel.com/api/blob`. */
  apiUrl?: string;
  /** Ghi đè phiên bản API — mặc định 12 (khớp SDK 2.8.0). */
  apiVersion?: string;
  /** Inject `fetch` để test. */
  fetchImpl?: typeof fetch;
}

export const VERCEL_BLOB_API_URL = 'https://vercel.com/api/blob';
export const VERCEL_BLOB_API_VERSION = '12';

export function parseBlobStoreId(token: string): string {
  const [, , , storeId = ''] = token.split('_');
  return storeId;
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StorageInvalidKeyError(key, 'rỗng');
  }
  if (key.includes('\0') || key.includes('\\') || key.startsWith('/')) {
    throw new StorageInvalidKeyError(key, 'ký tự/đường dẫn không hợp lệ');
  }
  if (key.includes('//') || key.split('/').some((s) => s === '..' || s === '.')) {
    throw new StorageInvalidKeyError(key, 'traversal hoặc "//"');
  }
}

export class VercelBlobStorageDriver implements StorageDriver {
  private readonly token: string;
  private readonly storeId: string;
  private readonly access: BlobAccess;
  private readonly apiUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: VercelBlobDriverConfig,
    private readonly logger: MinimalLogger = { warn: () => undefined },
  ) {
    this.token = config.token;
    this.storeId = parseBlobStoreId(config.token);
    this.access = config.access ?? 'public';
    this.apiUrl = (config.apiUrl ?? VERCEL_BLOB_API_URL).replace(/\/+$/, '');
    this.apiVersion = config.apiVersion ?? VERCEL_BLOB_API_VERSION;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** URL đọc của 1 key (public: dùng được trực tiếp trên trình duyệt). */
  blobUrl(key: string): string {
    assertKey(key);
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `https://${this.storeId}.${this.access}.blob.vercel-storage.com/${encoded}`;
  }

  private authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'x-api-version': this.apiVersion,
      'x-vercel-blob-store-id': this.storeId,
    };
  }

  async init(): Promise<void> {
    if (!this.storeId) {
      throw new Error(
        'BLOB_READ_WRITE_TOKEN thiếu hoặc sai định dạng (cần vercel_blob_rw_<storeId>_<secret>)',
      );
    }
  }

  async upload(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    contentLength?: number,
  ): Promise<string> {
    assertKey(key);
    const isStream = !Buffer.isBuffer(body);
    const size = isStream ? contentLength : body.length;
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'PUT',
      headers: {
        ...this.authHeaders(),
        'x-vercel-blob-access': this.access,
        'x-content-type': contentType,
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '1',
        ...(size !== undefined ? { 'x-content-length': String(size) } : {}),
      },
      body: isStream
        ? (Readable.toWeb(body) as unknown as ReadableStream)
        : new Uint8Array(body),
      ...(isStream ? { duplex: 'half' as const } : {}),
    };
    const res = await this.fetchImpl(
      `${this.apiUrl}/?${new URLSearchParams({ pathname: key }).toString()}`,
      init,
    );
    if (!res.ok) {
      throw new Error(`Vercel Blob upload thất bại (${res.status}): ${await safeText(res)}`);
    }
    return key;
  }

  /** Store public → URL công khai; store private không có URL chữ ký ở driver này. */
  async getPresignedUrl(key: string): Promise<string> {
    if (this.access === 'public') return this.blobUrl(key);
    throw new PresignNotSupportedError();
  }

  async getObjectStream(key: string): Promise<ObjectStream> {
    const r = await this.getObjectStreamRange(key);
    return { body: r.body, contentType: r.contentType, contentLength: r.contentLength };
  }

  async getObjectStreamRange(key: string, range?: string): Promise<RangedObjectStream> {
    const res = await this.fetchImpl(this.blobUrl(key), {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}`, ...(range ? { range } : {}) },
    });
    if (res.status === 404) throw new StorageObjectNotFoundError(key);
    if (!res.ok || !res.body) {
      throw new Error(`Vercel Blob đọc thất bại (${res.status}) key=${key}`);
    }
    const len = res.headers.get('content-length');
    return {
      body: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      contentLength: len ? Number(len) : undefined,
      statusCode: res.status === 206 ? 206 : 200,
      contentRange: res.headers.get('content-range') ?? undefined,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.apiUrl}/delete`, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ urls: [this.blobUrl(key)] }),
      });
      if (!res.ok) {
        this.logger.warn(`Could not delete blob ${key}: ${res.status} ${await safeText(res)}`);
      }
    } catch (err) {
      this.logger.warn(`Could not delete blob ${key}: ${(err as Error).message}`);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
