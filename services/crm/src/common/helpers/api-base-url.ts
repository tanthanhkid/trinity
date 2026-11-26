/**
 * Địa chỉ gốc của API bên ngoài (Graph API, Zalo) đọc từ env — để test hợp đồng trỏ mọi lời gọi tới máy chủ giả cục bộ.
 * Không đặt ⇒ dùng `fallback` (địa chỉ thật). `http://` chỉ nhận cho host loopback (`localhost`, `127.x.x.x`, `::1`) —
 * không phụ thuộc `NODE_ENV`, để không bao giờ gửi token qua mạng không mã hoá. Đọc env mỗi lần gọi (không cache) để
 * test đổi được giữa các ca.
 */
export function apiBaseUrl(name: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} không phải URL hợp lệ`);
  }
  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) throw new Error(`${name}: http:// chỉ dùng cho máy chủ cục bộ (localhost, 127.0.0.1, ::1) — dùng https://`);
  } else if (url.protocol !== 'https:') {
    throw new Error(`${name} chỉ nhận https:// (http:// cho máy chủ cục bộ)`);
  }
  if (url.search || url.hash) throw new Error(`${name} không được có query hay #`);
  return raw.replace(/\/+$/, '');
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}
