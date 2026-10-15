/**
 * Decode trường `exp` (giây) của 1 JWT → mốc hết hạn tính bằng MILLISECONDS.
 * Chỉ đọc payload (KHÔNG verify chữ ký — verify là việc của BE). Dùng client-side
 * để biết khi nào nên gia hạn token chủ động.
 *
 * Trả `null` khi: token rỗng/null, không đủ 3 phần, payload không decode được,
 * hoặc không có `exp` dạng số.
 */
export function decodeJwtExpMs(token: string | null): number | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}
