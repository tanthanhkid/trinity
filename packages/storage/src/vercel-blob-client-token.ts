import { createHmac } from 'node:crypto';
import {
  parseBlobStoreId,
  VERCEL_BLOB_API_URL,
  VERCEL_BLOB_API_VERSION,
  type BlobAccess,
} from './vercel-blob-driver';

/**
 * Token upload-từ-trình-duyệt (client upload) của Vercel Blob — cách duy nhất
 * đưa file > 4,5 MB lên khi body function bị Vercel chặn.
 * Thuật toán theo `generateClientTokenFromReadWriteToken` của SDK 2.8.0:
 *   payload = base64(JSON{pathname, maximumSizeInBytes, allowedContentTypes,
 *             addRandomSuffix, allowOverwrite, validUntil})
 *   sig     = HMAC-SHA256(rw-token, payload) dạng hex
 *   token   = `vercel_blob_client_<storeId>_` + base64(`${sig}.${payload}`)
 * Trình duyệt sau đó `PUT {uploadUrl}` với `authorization: Bearer <token>`.
 */
export interface ClientUploadGrantInput {
  token: string;
  pathname: string;
  maximumSizeInBytes: number;
  allowedContentTypes: string[];
  /** ms — mặc định 15 phút. */
  ttlMs?: number;
  now?: number;
}

export function generateClientUploadToken(input: ClientUploadGrantInput): string {
  const storeId = parseBlobStoreId(input.token);
  if (!storeId) throw new Error('BLOB_READ_WRITE_TOKEN sai định dạng');
  const payload = Buffer.from(
    JSON.stringify({
      pathname: input.pathname,
      maximumSizeInBytes: input.maximumSizeInBytes,
      allowedContentTypes: input.allowedContentTypes,
      addRandomSuffix: false,
      allowOverwrite: false,
      validUntil: (input.now ?? Date.now()) + (input.ttlMs ?? 15 * 60 * 1000),
    }),
  ).toString('base64');
  const sig = createHmac('sha256', input.token).update(payload).digest('hex');
  return `vercel_blob_client_${storeId}_${Buffer.from(`${sig}.${payload}`).toString('base64')}`;
}

export interface ClientUploadTarget {
  upload_url: string;
  headers: Record<string, string>;
}

/** URL + header trình duyệt cần để PUT trực tiếp lên Blob bằng client token. */
export function buildClientUploadTarget(
  clientToken: string,
  pathname: string,
  contentType: string,
  access: BlobAccess,
): ClientUploadTarget {
  return {
    upload_url: `${VERCEL_BLOB_API_URL}/?${new URLSearchParams({ pathname }).toString()}`,
    headers: {
      authorization: `Bearer ${clientToken}`,
      'x-api-version': VERCEL_BLOB_API_VERSION,
      'x-vercel-blob-store-id': parseBlobStoreId(clientToken),
      'x-vercel-blob-access': access,
      'x-content-type': contentType,
    },
  };
}
