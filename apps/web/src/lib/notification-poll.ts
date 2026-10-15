/**
 * Lõi thuần của chế độ poll thông báo: từ danh sách CHƯA ĐỌC mới nhất suy ra những thông báo cần toast.
 * - Lần đầu (`primed=false`): chỉ ghi nhớ id đang có, KHÔNG toast (tránh dội toast cho thông báo cũ khi tải trang) —
 *   khớp socket: socket chỉ đẩy thông báo MỚI phát sinh sau khi kết nối.
 * - Các lần sau: id chưa thấy → toast đúng 1 lần (Set `seen` chống trùng giữa các lượt poll / focus dồn dập).
 * - Socket chỉ đẩy kênh in_app ⇒ bỏ qua kênh khác nếu BE trả `channel`.
 */
export interface PolledNotification {
  id: number | string
  title: string
  body: string
  channel?: string
  event_type?: string | null
  action_url?: string | null
  is_read: boolean
  created_at: string
}

/** Trần số toast mỗi lượt (mở máy sau nghỉ trưa có thể có hàng chục thông báo mới → chỉ toast số mới nhất). */
export const MAX_TOASTS_PER_POLL = 5

export function pickNewNotifications(
  items: PolledNotification[],
  seen: Set<string>,
  primed: boolean,
): PolledNotification[] {
  const fresh = items.filter((n) => !seen.has(String(n.id)))
  for (const n of items) seen.add(String(n.id))
  if (!primed) return []
  return fresh
    .filter((n) => n.channel === undefined || n.channel === 'in_app')
    .reverse() // BE trả mới → cũ; toast theo thứ tự thời gian
    .slice(-MAX_TOASTS_PER_POLL)
}
