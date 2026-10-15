/**
 * Kênh nhắn tin (Zalo OA / Fanpage Facebook) TẮT cho tổ chức ⇒ BE trả 403 (`@RequireOrgFeature`).
 * Đó là trạng thái "kênh chưa bật", KHÔNG phải lỗi: hộp thư hiện trống, không hiện chữ đỏ,
 * không poll tiếp endpoint đang 403.
 */
export function isChannelOff(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const status = (err as { response?: { status?: unknown } }).response?.status
  return status === 403
}

/** `refetchInterval` cho query của kênh: dừng poll khi kênh tắt (403). */
export function pollUnlessChannelOff(ms: number) {
  return (query: { state: { error: unknown } }): number | false => (isChannelOff(query.state.error) ? false : ms)
}
