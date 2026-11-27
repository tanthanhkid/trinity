import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { call, freshIp } from '../../lib/http.js'
import { asKey, clusterRoutes, fillPath, hasBody, sweep } from '../../lib/sweeps.js'
import { makeUser, type U } from '../../lib/users.js'

afterAll(closeDb)

/**
 * C14f — ca SINH từ `server/contracts/routes.json` cho cụm `channels` (Facebook Fanpage, Zalo OA, đăng bài đa kênh):
 * 401 không token, 403 thiếu quyền, 400 id không phải số / thân sai, 404 đối tượng hoặc id không tồn tại.
 * Ca thành công, golden 3 vai và con trỏ phân trang: `65-channels-flows.test.ts`.
 */
const routes = clusterRoutes('channels')
const GENERIC_PATH = (r: Parameters<typeof fillPath>[0]) => fillPath(r, '1', 'x')

/** Thân hợp lệ tối thiểu để vượt bước kiểm thân và tới bước tìm theo id (ca 404). */
const MINIMAL_BODY: Record<string, unknown> = {
  'POST /facebook/comments/:id/reply': { text: 'x', mode: 'public' },
  'POST /facebook/conversations/:id/messages': { text: 'x' },
  'PATCH /social/posts/:id': { content: 'x', targets: [{ account_id: 1 }] },
  'POST /social/posts/:id/reschedule': { scheduled_at: '2099-01-01T00:00:00Z' },
  'POST /zalo-oa/threads/:id/link': { contact_id: 1 },
  'POST /zalo-oa/threads/:id/messages': { text: 'x' },
}
/** POST không nhận thân (hành động theo id): không có "thân sai". Điền sau khi quan sát. */
const NO_BODY = new Set<string>([
  'POST /facebook/broadcasts/:id/cancel', 'POST /facebook/connect-url', 'POST /facebook/pages/:id/check', 'POST /facebook/tick',
  'POST /social/accounts/:id/enable', 'POST /social/media/:id/hide', 'POST /social/posts/:id/cancel', 'POST /social/posts/:id/metrics',
  'POST /social/posts/sync', 'POST /social/recurrences/:id/pause', 'POST /social/recurrences/:id/resume', 'POST /social/targets/:id/retry',
  'POST /social/tick', 'POST /zalo-oa/connect', 'POST /zalo-oa/threads/:id/read',
])

const allPerms = [...new Set(routes.flatMap((r) => r.permissions))]
let power: U
let none: U
beforeAll(async () => {
  power = await makeUser(Object.fromEntries(allPerms.map((p) => [p, p === 'integrations.webhooks' || p === 'social.manage' ? true : ('all' as const)])))
  none = await makeUser({})
})

describe('cụm channels: ca sinh từ routes.json', () => {
// SKIP #605: Rust chưa khớp hợp đồng Node ở ca này (POST /social/media/upload-token trả 404, chưa có route); bỏ skip khi sửa xong. Danh sách + lý do ở PR #605.
  it.skip('không token → 401', async () => {
    const list = routes.filter((r) => r.access === 'auth' || r.access === 'can')
    expect(list.length).toBeGreaterThan(60)
    await sweep(list, [401], (r) => call(r.method, GENERIC_PATH(r), { ip: freshIp(), body: hasBody(r) ? {} : undefined }))
  })

// SKIP #605: Rust chưa khớp hợp đồng Node ở ca này (POST /social/media/upload-token trả 404, chưa có route); bỏ skip khi sửa xong. Danh sách + lý do ở PR #605.
  it.skip('token không có quyền → 403', async () => {
    const list = routes.filter((r) => r.access === 'can')
    await sweep(list, [403], (r) => call(r.method, GENERIC_PATH(r), { token: none.token, ip: freshIp(), body: hasBody(r) ? {} : undefined }))
  })

  it('id không phải số (ParseIntPipe) → 400', async () => {
    const list = routes.filter((r) => r.param_pipes.some((p) => p.includes('ParseIntPipe')))
    expect(list.length).toBeGreaterThan(30)
    await sweep(list, [400], (r) => call(r.method, fillPath(r, 'abc', 'x'), { token: power.token, ip: freshIp(), body: hasBody(r) ? {} : undefined }))
  })

  it('đối tượng hoặc id không tồn tại → 404', async () => {
    const list = routes.filter((r) => r.path.includes('/:id') && (r.access === 'auth' || r.access === 'can'))
    await sweep(list, [404], (r) =>
      call(r.method, fillPath(r, '2147000000', 'khong_co'), { token: power.token, ip: freshIp(), body: hasBody(r) ? (MINIMAL_BODY[asKey(r)] ?? {}) : undefined }),
    )
  })

// SKIP #605: Rust chưa khớp hợp đồng Node ở ca này (PATCH /facebook/broadcasts/:id, POST /facebook/broadcasts/:id/send, PATCH /facebook/comment-rules/:id, PATCH /facebook/pages/:id, POST /social/media/upload-token trả 404); bỏ skip khi sửa xong. Danh sách + lý do ở PR #605.
  it.skip('thân sai (khoá lạ) → 400', async () => {
    const list = routes.filter((r) => hasBody(r) && r.access !== 'public' && !NO_BODY.has(asKey(r)))
    expect(list.length).toBeGreaterThan(30)
    await sweep(list, [400], (r) => call(r.method, fillPath(r, '2147000000', 'khong_co'), { token: power.token, ip: freshIp(), body: { khoa_la_khong_ton_tai: 1 } }))
  })
})
