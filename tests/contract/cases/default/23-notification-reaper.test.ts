import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser, type SeededUser } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { loginAdmin } from '../../lib/session.js'

const made: SeededUser[] = []
const mk = async (o: Parameters<typeof seedUser>[0]) => {
  const u = await seedUser(o)
  made.push(u)
  return u
}

/** Dọn MỌI dòng thông báo file này tạo (kể cả `scheduled` hẹn giờ và `processing` mốc cũ) để job của ca khác không gom nhầm. */
afterAll(async () => {
  await q(`DELETE FROM notification_logs WHERE recipient_id = ANY($1)`, [made.map((u) => u.id)])
  await closeDb()
})

/**
 * Chuyển từ `apps/monolith/test/rbac/notification-reaper.e2e-spec.ts` (2 ca): thông báo hẹn giờ giữ `webhook_url`,
 * reaper trả dòng kẹt `processing` về `scheduled` hoặc `failed`.
 * - `createLog` (gọi thẳng service ở bản cũ) → `POST /notifications/send` có `scheduled_at` tương lai, rồi đọc dòng log bằng SQL.
 * - `reapStuckProcessing(NOW)` → API điều khiển `notification.reap-stuck` kèm `now`. Mốc thời gian của các dòng seed tính từ cùng
 *   `base`, và `base` lùi 400 ngày: dòng `processing` của ca khác (mốc gần bây giờ) nằm sau `now` nên reaper không đụng tới.
 */
describe('thông báo hẹn giờ: webhook_url + reaper', () => {
  it('gửi hẹn giờ lưu webhook_url (để lúc gửi hẹn giờ vẫn có)', async () => {
    const u = await mk({ label: 'wh', grants: {} })
    const token = (await loginAdmin()).token
    const res = await api.post('/notifications/send', {
      token,
      ip: freshIp(),
      body: {
        user_id: u.id,
        channel: 'webhook',
        title: 't',
        body: 'b',
        metadata: { webhook_url: 'https://hooks.example.com/x' },
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    })
    expect(res.status).toBe(201)
    const id = (res.body as { id: number; status: string }).id
    expect((res.body as { status: string }).status).toBe('scheduled')
    const [row] = await q<{ webhook_url: string }>(`SELECT webhook_url FROM notification_logs WHERE id = $1`, [id])
    expect(row.webhook_url).toBe('https://hooks.example.com/x')
  })

  it('reaper: kẹt > 15 phút còn lượt → scheduled; hết lượt → failed; còn mới hoặc dòng khác → không đụng', async () => {
    const u = await mk({ label: 'reap', grants: {} })
    const base = Date.now() - 400 * 86_400_000
    const at = (minutesAgo: number | null): string | null => (minutesAgo === null ? null : new Date(base - minutesAgo * 60_000).toISOString())
    const mkLog = async (status: string, claimed: number | null, scheduled: number | null, retry: number): Promise<number> => {
      const [r] = await q<{ id: number }>(
        `INSERT INTO notification_logs (recipient_id, channel, title, body, status, claimed_at, scheduled_at, retry_count)
         VALUES ($1, 'in_app', 't', 'b', $2, $3, $4, $5) RETURNING id`,
        [u.id, status, at(claimed), at(scheduled), retry],
      )
      return r.id
    }
    const stuck = await mkLog('processing', 30, 31, 0)
    const exhausted = await mkLog('processing', 30, 31, 2)
    const legacy = await mkLog('processing', null, 60, 0)
    const fresh = await mkLog('processing', 2, 3, 0)
    const sent = await mkLog('sent', 90, null, 0)

    const res = await control.runJob('notification.reap-stuck', { now: new Date(base).toISOString() })
    expect(res.status).toBe(200)
    expect((res.body as { result: unknown }).result).toEqual({ requeued: 2, failed: 1 })

    const get = async (id: number) =>
      (await q<{ status: string; retry_count: number; claimed_at: string | null; error: string | null }>(`SELECT status, retry_count, claimed_at, error FROM notification_logs WHERE id = $1`, [id]))[0]
    expect(await get(stuck)).toMatchObject({ status: 'scheduled', retry_count: 1, claimed_at: null })
    expect(await get(legacy)).toMatchObject({ status: 'scheduled', retry_count: 1 })
    expect(await get(exhausted)).toMatchObject({ status: 'failed', retry_count: 3 })
    expect((await get(exhausted)).error).toContain('processing')
    expect((await get(fresh)).status).toBe('processing')
    expect((await get(sent)).status).toBe('sent')
  })
})
