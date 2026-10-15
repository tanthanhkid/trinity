import { Logger } from '@nestjs/common';

const logger = new Logger('DecodeMultipartFilename');

// C0 control chars (0x00-0x1F), DEL (0x7F), và separators (/, \) phải bị
// loại khỏi filename: CRLF gây header injection khi echo vào Content-Disposition,
// NUL cắt ngắn filesystem path, / \ gây path traversal khi làm S3 key.
const UNSAFE_CHARS_RE = /[\x00-\x1F\x7F/\\]/g;

/**
 * Fix Vietnamese mojibake trong filename multipart/form-data rồi sanitize
 * control chars/path separators.
 *
 * Multer (busboy) decode filename param trong Content-Disposition bằng Latin-1
 * mặc định, nhưng browser gửi bytes UTF-8 → chuỗi JS bị mojibake, ví dụ:
 * "Lê Thị" (UTF-8) bị hiểu thành "LÃª Thá»‹" (Latin-1). Function reinterpret
 * chuỗi như bytes Latin-1 rồi decode lại thành UTF-8 khôi phục tên gốc.
 *
 * Chỉ áp dụng khi chuỗi nằm hoàn toàn trong range Latin-1 (≤ 0xFF) — có ký tự
 * ngoài range nghĩa là multer/client đã decode UTF-8 đúng, không double-decode.
 *
 * Output luôn được sanitize: CR/LF/NUL/DEL và path separator (/, \) replace
 * bằng "_" để an toàn khi ghép vào HTTP header hoặc S3 key.
 */
export function decodeMultipartFilename(
  raw: string | undefined | null,
): string {
  if (!raw) return '';
  const decoded = tryDecodeLatin1Mojibake(raw);
  return sanitizeUnsafeChars(decoded);
}

/**
 * Sửa mojibake Latin-1↔UTF-8 cho text HIỂN THỊ (vd: tên file mẫu đã lưu DB từ
 * trước khi có `decodeMultipartFilename` ở luồng upload). KHÔNG sanitize ký tự
 * (giữ nguyên text), khác `decodeMultipartFilename` (dùng cho storage key/header).
 *
 * IDEMPOTENT — an toàn áp lại nhiều lần:
 * - Tên UTF-8 đúng (có ký tự tiếng Việt > 0xFF, vd "ế" U+1EBF) → trả NGUYÊN.
 * - Tên mojibake (toàn ký tự ≤ 0xFF, vd "áº¿") → decode lại về "ế".
 * - Decode ra UTF-8 không hợp lệ (U+FFFD) → trả nguyên (không làm tệ hơn).
 */
export function repairMojibakeText(raw: string | undefined | null): string {
  if (!raw) return '';
  return tryDecodeLatin1Mojibake(raw);
}

function tryDecodeLatin1Mojibake(raw: string): string {
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 0xff) return raw;
  }
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  // Invalid UTF-8 sequences → Buffer chèn U+FFFD. Giữ nguyên raw (mojibake)
  // thay vì emit corrupted string, kèm warn để ops quan sát corruption rate.
  if (decoded.includes('�')) {
    logger.warn(
      `Filename decode fallback (invalid UTF-8 after Latin-1 reinterpret): len=${raw.length}`,
    );
    return raw;
  }
  return decoded;
}

function sanitizeUnsafeChars(input: string): string {
  // Reset lastIndex trước khi test (UNSAFE_CHARS_RE là /g flag → stateful)
  UNSAFE_CHARS_RE.lastIndex = 0;
  const hasUnsafe = UNSAFE_CHARS_RE.test(input);
  UNSAFE_CHARS_RE.lastIndex = 0;
  if (hasUnsafe) {
    // Observability: log khi filename bị strip để track corruption rate /
    // phát hiện attacker cố chèn CRLF/NUL/path-sep. Log chỉ length để tránh
    // leak PII filename vào ELK.
    logger.warn(
      `Filename sanitized (unsafe chars stripped): len=${input.length}`,
    );
  }
  return input.replace(UNSAFE_CHARS_RE, '_').trim();
}
