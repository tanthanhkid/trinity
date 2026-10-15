/** Giới hạn kích thước ảnh selfie chấm công (5MB) — ảnh camera JPEG nén thường < 1MB. */
export const SELFIE_MAX_SIZE = 5 * 1024 * 1024;

/** Whitelist MIME ảnh selfie. canvas.toBlob mặc định trả image/jpeg hoặc image/png. */
export const SELFIE_ALLOWED_MIME = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
] as const;

/**
 * Map MIME → đuôi file an toàn cho object key.
 * Lấy ext từ MIME (KHÔNG từ originalname) — chống path traversal.
 */
export const SELFIE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
