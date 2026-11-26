import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser } from '../../lib/db.js'
import { control } from '../../lib/http.js'

afterAll(closeDb)

describe('API điều khiển test: chạy job', () => {
  it('lead-scoring chạy một lượt cho công ty 1 và trả kết quả', async () => {
    const res = await control.runJob('lead-scoring')
    expect(res.status).toBe(200)
    expect((res.body as { job: string }).job).toBe('lead-scoring')
  })

  it('job không có trong danh sách trả 400', async () => {
    const res = await control.runJob('khong-co')
    expect(res.status).toBe(400)
  })

  it('có tham số `now`: reap-stuck trả dòng kẹt `processing` về `scheduled` theo giờ giả', async () => {
    const u = await seedUser({ label: 'reap', grants: {} })
    // Dòng claim cách đây 30 phút theo `now()` của DB: với giờ thật thì đã kẹt; với `now` lùi 1 giờ thì chưa kẹt.
    const [row] = await q<{ id: number }>(
      `INSERT INTO notification_logs (recipient_id, channel, status, claimed_at, retry_count)
       VALUES ($1, 'in_app', 'processing', now() - interval '30 minutes', 0) RETURNING id`,
      [u.id],
    )
    const early = await control.runJob('notification.reap-stuck', { now: new Date(Date.now() - 3_600_000).toISOString() })
    expect(early.status).toBe(200)
    expect((await q<{ status: string }>(`SELECT status FROM notification_logs WHERE id = $1`, [row.id]))[0].status).toBe('processing')
    const late = await control.runJob('notification.reap-stuck')
    expect(late.status).toBe(200)
    expect((await q<{ status: string }>(`SELECT status FROM notification_logs WHERE id = $1`, [row.id]))[0].status).toBe('scheduled')
  })

  it('`now` chỉ nhận cho job đã nhận giờ làm đối số: job khác trả 400', async () => {
    const res = await control.runJob('lead-scoring', { now: '2026-01-01T00:00:00Z' })
    expect(res.status).toBe(400)
  })
})
