import { syncBus } from '@trinity/prisma'

/** Số dòng tối đa một tin `bell` (giữ payload dưới 8 KB của Postgres: mỗi id ~8 byte). */
const BELL_CHUNK = 200

/**
 * G12b — báo các tiến trình khác (Node thứ hai, Rust) rằng có thông báo mới / số chưa đọc đổi. Payload chỉ mang khoá:
 * `u` = id user nhận, `n` = id `notification_logs` (bên nhận đọc nội dung từ DB). `n` rỗng ⇒ chỉ làm mới số chưa đọc
 * (vd đánh dấu đã đọc). Bắn rồi quên; chưa bật bus thì không làm gì.
 */
export function publishBell(userIds: number[], notificationIds: number[]): void {
  const users = [...new Set(userIds)]
  if (users.length === 0 && notificationIds.length === 0) return
  const ids = [...new Set(notificationIds)]
  const chunks = Math.max(Math.ceil(users.length / BELL_CHUNK), Math.ceil(ids.length / BELL_CHUNK), 1)
  for (let i = 0; i < chunks; i++) {
    void syncBus.publish('bell', {
      u: users.slice(i * BELL_CHUNK, (i + 1) * BELL_CHUNK),
      n: ids.slice(i * BELL_CHUNK, (i + 1) * BELL_CHUNK),
    })
  }
}
