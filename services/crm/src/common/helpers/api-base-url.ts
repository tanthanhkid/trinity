/**
 * Địa chỉ gốc của API bên ngoài (Graph API, Zalo) đọc từ env — để test hợp đồng trỏ mọi lời gọi tới máy chủ giả cục bộ.
 * Không đặt ⇒ dùng `fallback` (địa chỉ thật). `http://` chỉ nhận ngoài production; production đặt `http://` ⇒ báo lỗi,
 * không âm thầm gửi token qua kênh không mã hoá. Đọc env mỗi lần gọi (không cache) để test đổi được giữa các ca.
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
    if (env.NODE_ENV === 'production') throw new Error(`${name} phải dùng https:// ở production`);
  } else if (url.protocol !== 'https:') {
    throw new Error(`${name} chỉ nhận https:// (http:// ngoài production)`);
  }
  if (url.search || url.hash) throw new Error(`${name} không được có query hay #`);
  return raw.replace(/\/+$/, '');
}
