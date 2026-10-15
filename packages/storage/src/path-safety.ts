import { resolve, sep, posix } from 'node:path';
import { StorageInvalidKeyError } from './types';

/**
 * Chuyển 1 storage key (do người dùng đặt tên file — KHÔNG tin cậy) thành
 * đường dẫn tuyệt đối THẬT SỰ nằm trong `root`, hoặc throw `StorageInvalidKeyError`.
 *
 * 🔴 Đây là tuyến phòng thủ DUY NHẤT chống path traversal cho toàn bộ driver
 * lưu đĩa. Có caller đã tự sanitize filename,
 * có caller CHƯA — hàm này PHẢI tự đứng vững bất kể caller có
 * sanitize hay không (defense in depth), vì driver là async storage-service dùng
 * chung cho nhiều service, không kiểm soát được hết mọi callsite tương lai.
 *
 * Chặn:
 * - Key rỗng.
 * - Null byte (`\0`) — cắt ngắn path ở tầng OS trên 1 số filesystem/driver cũ.
 * - Đường dẫn tuyệt đối (`/etc/passwd`, `\\server\share`, `C:\...`).
 * - `..` ở BẤT KỲ vị trí nào sau khi normalize (traversal ra ngoài root).
 * - Kết quả `path.resolve(root, key)` không còn nằm trong `root` (double-check
 *   cuối cùng, không tin riêng việc đã lọc `..` — vd ký tự Unicode lookalike bị
 *   OS normalize khác lúc runtime).
 */
export function resolveSafeKey(root: string, key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StorageInvalidKeyError(key, 'rỗng');
  }
  if (key.includes('\0')) {
    throw new StorageInvalidKeyError(key, 'chứa null byte');
  }

  // Key LUÔN dùng dấu `/` (quy ước nội bộ toàn repo), bất kể OS chạy
  // driver là gì. Từ chối backslash tường minh — Windows-style traversal
  // (`..\\..\\`) không được coi là "đường dẫn hợp lệ" ở tầng key.
  if (key.includes('\\')) {
    throw new StorageInvalidKeyError(key, 'chứa backslash');
  }

  // Đường dẫn tuyệt đối kiểu POSIX (`/etc/passwd`) hoặc ổ đĩa Windows (`C:`).
  if (key.startsWith('/') || /^[a-zA-Z]:/.test(key)) {
    throw new StorageInvalidKeyError(key, 'là đường dẫn tuyệt đối');
  }

  const normalized = posix.normalize(key);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new StorageInvalidKeyError(key, 'traversal ra ngoài root (..)');
  }

  const rootResolved = resolve(root);
  const target = resolve(rootResolved, normalized);

  // Double-check cuối: target PHẢI nằm trong rootResolved (hoặc bằng chính nó,
  // dù thực tế không xảy ra vì key không rỗng). So sánh bằng prefix + separator
  // để tránh false-positive kiểu root=/var/lib/trinity/storage khớp nhầm
  // /var/lib/trinity/storage-evil.
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new StorageInvalidKeyError(key, 'nằm ngoài storage root sau khi resolve');
  }

  return target;
}
