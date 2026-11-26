import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/**
 * C08, từ `deals-won-date.e2e-spec.ts` (1 ca). Bản tin đếm deal thắng theo NGÀY THẮNG (`won_at`), dữ liệu cũ (`won_at` NULL) rơi về
 * `updated_at`. Ca gốc gọi `BriefingAggregatorService.collect(…, NOW)` trong tiến trình; ở đây đi qua API điều khiển test
 * (`briefings.collect` với `now`), là một trong đúng hai chỗ mã nhận giờ làm đối số. Mốc thời gian là tuyệt đối vì `now` do ca truyền.
 */
const NOW = '2026-10-07T01:00:00Z' // 08:00 VN sáng, kỳ = 06/10 VN
const IN_PERIOD = '2026-10-06T03:00:00Z'
const BEFORE = '2026-09-20T03:00:00Z'

describe('deal thắng theo ngày thắng', () => {
  it('chuyển sang won qua API ghi won_at; bản tin đếm theo won_at, dữ liệu cũ theo updated_at', async () => {
    const boss = await seedUser({ label: 'boss', grants: { 'deals.manage': null, 'deals.view': 'all', 'contacts.view': 'all' } })
    const mk = async (title: string): Promise<number> =>
      (await q<{ id: number }>(`INSERT INTO deals (title, assigned_to, created_by, value, updated_at) VALUES ($1, $2, $2, 100, now()) RETURNING id`, [title, boss.id]))[0].id
    const viaApi = await mk('qua API')
    const wonLongAgoTouchedNow = await mk('thắng cũ, vừa sửa')
    const legacy = await mk('dữ liệu cũ')
    const legacyOld = await mk('dữ liệu cũ, thắng từ lâu')

    const token = (await loginSeeded(boss)).token
    const patch = await api.patch(`/deals/${viaApi}`, { token, body: { status: 'won' }, ip: freshIp() })
    expect(patch.status).toBe(200)
    expect((await q<{ won_at: string | null }>(`SELECT won_at FROM deals WHERE id = $1`, [viaApi]))[0].won_at).not.toBeNull()

    // Thắng từ tháng trước nhưng updated_at vừa bị chạm vào kỳ này → KHÔNG được tính vào kỳ này.
    await q(`UPDATE deals SET status = 'won', won_at = $2, updated_at = $3 WHERE id = $1`, [wonLongAgoTouchedNow, BEFORE, IN_PERIOD])
    // Dữ liệu cũ (won_at NULL): rơi về updated_at.
    await q(`UPDATE deals SET status = 'won', won_at = NULL, updated_at = $2 WHERE id = $1`, [legacy, IN_PERIOD])
    await q(`UPDATE deals SET status = 'won', won_at = NULL, updated_at = $2 WHERE id = $1`, [legacyOld, BEFORE])
    // Deal tạo qua API ở kỳ này: đặt won_at vào kỳ để so sánh ổn định (API ghi now thật, ngoài kỳ giả lập).
    await q(`UPDATE deals SET won_at = $2 WHERE id = $1`, [viaApi, IN_PERIOD])

    await control.flushCache()
    const res = await control.runJob('briefings.collect', { owner: [boss.id], slot: 'morning', now: NOW })
    expect(res.status).toBe(200)
    const metrics = (res.body as { result: { metrics: { dealsWon: { value: number }; wonValue: { value: number } } } }).result.metrics
    expect(metrics.dealsWon.value).toBe(2) // viaApi (won_at) + legacy (updated_at)
    expect(metrics.wonValue.value).toBe(200)
  })
})
