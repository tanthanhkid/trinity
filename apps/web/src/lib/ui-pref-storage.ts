/**
 * Đọc/ghi tuỳ chọn UI per-trình-duyệt trong localStorage (tiền tố `trinity:`).
 *
 * Dự án mới — không có khoá/phiên cũ nào cần giữ tương thích ngược.
 *
 * ⚠️ Mọi truy cập localStorage đều bọc try/catch: private mode / site data bị
 * chặn / quota đầy đều THROW, và các khoá này chỉ là tiện lợi — không được làm
 * vỡ render. SSR-safe qua guard `typeof window`.
 */

function isClient(): boolean {
  return typeof window !== 'undefined'
}

export function readUiPref(key: string): string | null {
  if (!isClient()) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeUiPref(key: string, value: string): void {
  if (!isClient()) return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* localStorage bị chặn — bỏ qua, state trong memory vẫn đúng */
  }
}

export function removeUiPref(key: string): void {
  if (!isClient()) return
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
