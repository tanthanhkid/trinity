import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { config } from '../../lib/config.js'
import { recordCall } from '../../lib/coverage.js'
import { api, call, freshIp, type Res } from '../../lib/http.js'
import { encryptSecret, mock } from '../../lib/channels.js'
import { makeUser, type U } from '../../lib/users.js'

/**
 * C14f — ca thành công / đầu vào sai cho cụm đăng bài đa kênh (`/social/*`) của cụm `channels`, qua máy chủ giả Graph (C06b).
 * Bài hẹn giờ ở tương lai nên không có lời gọi đăng thật; ca nào chạm Graph khai kịch bản bằng `mock.rules`.
 */
const ok = <T>(res: Res, status: number | number[], what: string): T => {
  expect([status].flat(), `${what}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`).toContain(res.status)
  return res.body as T
}
let admin: U
let accountId = 0
let seq = 0
const t = () => ({ token: admin.token, ip: freshIp() })
const future = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString()

async function seedAccount(externalId: string): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO social_accounts (network, external_id, name, access_token_enc, scopes, status, connected_by, updated_at)
     VALUES ('facebook', $1, $2, $3, 'pages_manage_posts', 'active', $4, now()) RETURNING id`,
    [externalId, `Kênh ${externalId}`, encryptSecret('social-token-mock'), admin.id],
  )
  return row.id
}

beforeAll(async () => {
  admin = await makeUser({ 'social.post': true, 'social.manage': true, 'integrations.webhooks': true })
  accountId = await seedAccount(`5000${Date.now().toString().slice(-6)}`)
})
beforeEach(async () => {
  await mock.reset()
})
afterEach(async () => {
  expect(await mock.unexpected()).toEqual([])
})
afterAll(closeDb)

/** Phản hồi tạo có thể bọc trong `data`. */
const idOf = (b: { id?: number; data?: { id: number } }): number => (b.id ?? (b.data as { id: number }).id) as number

const post = (title = 'Bài hợp đồng') => ({ content: `${title} ${++seq}`, targets: [{ account_id: accountId }], scheduled_at: future(30) })

describe('kênh và mạng', () => {
  it('mạng, kênh, link liên kết, bật lại, gỡ kênh; callback OAuth', async () => {
    ok(await api.get('/social/networks', t()), 200, 'mạng')
    ok(await api.get('/social/accounts', t()), 200, 'kênh')
    ok(await api.post('/social/accounts/connect-url', { ...t(), body: { network: 'facebook' } }), 200, 'link liên kết')
    ok(await api.post('/social/accounts/connect-url', { ...t(), body: { network: 'khong-co' } }), 400, 'mạng lạ')
    const spare = await seedAccount(`6000${Date.now().toString().slice(-6)}`)
    await q(`UPDATE social_accounts SET status = 'disabled' WHERE id = $1`, [spare])
    ok(await api.post(`/social/accounts/${spare}/enable`, t()), 200, 'bật lại')
    ok(await api.post(`/social/accounts/${spare}/enable`, t()), 400, 'bật kênh đang bật')
    ok(await api.del(`/social/accounts/${spare}`, t()), 204, 'gỡ kênh')
    expect((await call('GET', '/api/v1/social/oauth/callback/facebook?error=access_denied', { ip: freshIp() })).status).toBe(302)
  })
})

describe('thư viện ảnh/video', () => {
  it('kiểm trước khi tải, tải lên, thư viện, xem tệp, ẩn, link ký công khai', async () => {
    ok(await api.post('/social/media/upload-token', { ...t(), body: { file_name: 'a.png', size: 100 } }), 400, 'kiểm trước khi tải luôn 400')
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const upload = async (name: string, bytes: Uint8Array): Promise<{ status: number; json: { key?: string } }> => {
      const form = new FormData()
      form.append('file', new Blob([bytes as BlobPart], { type: 'image/png' }), name)
      const res = await fetch(`${config.baseUrl}/api/v1/social/media`, { method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'x-real-ip': freshIp() }, body: form })
      recordCall('POST', '/api/v1/social/media', res.status, true)
      return { status: res.status, json: (await res.json().catch(() => ({}))) as { key?: string } }
    }
    const bad = await upload('a.txt', new TextEncoder().encode('khong phai anh'))
    expect(bad.status).toBe(400)
    const good = await upload('a.png', png)
    expect(good.status, JSON.stringify(good.json)).toBe(201)
    const lib = ok<{ data?: { id: number; key: string }[]; items?: { id: number; key: string }[] }>(await api.get('/social/media', t()), 200, 'thư viện')
    const rows = lib.data ?? lib.items ?? []
    const asset = rows.find((r) => r.key === good.json.key)
    expect(asset, 'tệp vừa tải phải có trong thư viện').toBeTruthy()
    const id = (asset as { id: number }).id
    const file = await call('GET', `/api/v1/social/media/${id}/file`, { token: admin.token, ip: freshIp() })
    expect(file.status).toBe(200)
    // Link ký công khai: cùng cách ký của máy chủ (HMAC theo JWT_SECRET của hồ sơ); `?cid=1` chọn công ty 1.
    const secret = 'contract-jwt-secret-0123456789abcdef0123456789'
    const key = createHmac('sha256', 'trinity-social-media-link-v1').update(secret).digest()
    const body = Buffer.from(JSON.stringify({ k: good.json.key, t: 'image/png', e: Math.floor(Date.now() / 1000) + 600, c: 1 })).toString('base64url')
    const token = `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`
    const link = await call('GET', `/api/v1/social/media-link/${token}/a.png?cid=1`, { ip: freshIp() })
    expect(link.status, JSON.stringify(link.body).slice(0, 200)).toBe(200)
    ok(await api.post(`/social/media/${id}/hide`, t()), 200, 'ẩn tệp')
  })
})

describe('bài đăng', () => {
  it('xem trước, tạo, danh sách, xem, sửa, hẹn lại, huỷ', async () => {
    ok(await api.post('/social/posts/preview', { ...t(), body: post('Xem trước') }), 200, 'xem trước')
    const created = ok<{ id: number }>(await api.post('/social/posts', { ...t(), body: post() }), 201, 'tạo bài')
    ok(await api.get('/social/posts', t()), 200, 'danh sách')
    ok(await api.get(`/social/posts/${created.id}`, t()), 200, 'xem')
    ok(await api.patch(`/social/posts/${created.id}`, { ...t(), body: post('Đã sửa') }), 200, 'sửa')
    ok(await api.post(`/social/posts/${created.id}/reschedule`, { ...t(), body: { scheduled_at: future(31) } }), 200, 'hẹn lại')
    ok(await api.post(`/social/posts/${created.id}/cancel`, t()), 200, 'huỷ')
  })

  it('số liệu, đồng bộ, đăng lại kênh lỗi, gỡ bài đã đăng, tick', async () => {
    await mock.rules(
      { match: `GET /^${accountId}_9001$/`, status: 200, json: { id: `${accountId}_9001`, shares: { count: 1 }, reactions: { summary: { total_count: 2 } }, comments: { summary: { total_count: 3 } } } },
      { match: 'POST /feed$/', status: 200, json: { id: 'mock_post_1' } },
      { match: `DELETE ${accountId}_9001`, status: 200, json: { success: true } },
    )
    const created = ok<{ id: number; targets?: { id: number }[] }>(await api.post('/social/posts', { ...t(), body: post('Số liệu') }), 201, 'tạo bài')
    const [target] = await q<{ id: number }>(`SELECT id FROM social_post_targets WHERE post_id = $1 LIMIT 1`, [created.id])
    // Kênh đã đăng (seed): số liệu lấy từ Graph, gỡ bài gọi Graph DELETE.
    await q(`UPDATE social_post_targets SET status = 'published', external_post_id = $2, published_at = now() WHERE id = $1`, [target.id, `${accountId}_9001`])
    ok(await api.post(`/social/posts/${created.id}/metrics`, t()), 200, 'số liệu')
    ok(await api.post('/social/posts/sync', t()), 200, 'đồng bộ')
    ok(await api.post('/social/tick', t()), 200, 'tick')
    ok(await api.del(`/social/targets/${target.id}/remote`, t()), 200, 'gỡ bài đã đăng')
    await q(`UPDATE social_post_targets SET status = 'failed', last_error = 'seed' WHERE id = $1`, [target.id])
    ok(await api.post(`/social/targets/${target.id}/retry`, t()), 200, 'đăng lại')
    // Đăng lại chạy nền: chờ lời gọi Graph tới (còn kịch bản) để không rơi sang ca sau, khi kịch bản đã được đặt lại.
    for (let i = 0; i < 50 && !(await mock.calls()).some((c) => c.method === 'POST' && c.path.endsWith('/feed')); i++) await new Promise((r) => setTimeout(r, 100))
    expect((await mock.calls()).some((c) => c.method === 'POST' && c.path.endsWith('/feed')), 'đăng lại phải gọi Graph').toBe(true)
    await new Promise((r) => setTimeout(r, 300))
  })

  it('nhập hàng loạt: kế hoạch rồi thực hiện', async () => {
    const csv = `content,scheduled_at\n"Bài nhập ${seq + 1}",${future(40)}\n`
    const planRes = ok<{ data: { plan_hash: string } }>(await api.post('/social/posts/import/plan', { ...t(), body: { csv, mode: 'drafts' } }), 200, 'kế hoạch')
    const hash = planRes.data.plan_hash
    ok(await api.post('/social/posts/import', { ...t(), body: { csv, mode: 'drafts', plan_hash: hash } }), 200, 'nhập')
  })
})

describe('bản nháp, mẫu chữ, hàng đợi, bài lặp, thống kê', () => {
  it('bản nháp: tạo, danh sách, xem, sửa, đăng, xoá', async () => {
    const d = ok<{ id?: number; data?: { id: number } }>(await api.post('/social/drafts', { ...t(), body: { title: 'Nháp', content: 'Nội dung nháp', targets: [{ account_id: accountId }], scheduled_at: future(35) } }), 201, 'tạo nháp')
    ok(await api.get('/social/drafts', t()), 200, 'danh sách nháp')
    ok(await api.get(`/social/drafts/${idOf(d)}`, t()), 200, 'xem nháp')
    ok(await api.patch(`/social/drafts/${idOf(d)}`, { ...t(), body: { title: 'Nháp đã sửa' } }), 200, 'sửa nháp')
    ok(await api.post(`/social/drafts/${idOf(d)}/publish`, { ...t(), body: {} }), 200, 'đăng nháp')
    const d2 = ok<{ id?: number; data?: { id: number } }>(await api.post('/social/drafts', { ...t(), body: { title: 'Nháp xoá' } }), 201, 'tạo nháp 2')
    ok(await api.del(`/social/drafts/${idOf(d2)}`, t()), 204, 'xoá nháp')
  })

  it('mẫu chữ: tạo, danh sách, sửa, xoá', async () => {
    const s = ok<{ id?: number; data?: { id: number } }>(await api.post('/social/snippets', { ...t(), body: { kind: 'hashtags', name: 'Thẻ', content: '#trinity' } }), 201, 'tạo mẫu')
    ok(await api.get('/social/snippets', t()), 200, 'danh sách mẫu')
    ok(await api.patch(`/social/snippets/${idOf(s)}`, { ...t(), body: { name: 'Thẻ đã sửa' } }), 200, 'sửa mẫu')
    ok(await api.del(`/social/snippets/${idOf(s)}`, t()), 204, 'xoá mẫu')
  })

  it('hàng đợi: khung giờ, khung trống kế tiếp', async () => {
    ok(await api.put('/social/queue/slots', { ...t(), body: { slots: [{ weekday: 1, minute: 540 }, { weekday: 3, minute: 600 }] } }), 200, 'đặt khung giờ')
    ok(await api.get('/social/queue/slots', t()), 200, 'khung giờ')
    ok(await api.get('/social/queue/next?count=2', t()), 200, 'khung trống')
  })

  it('bài lặp: tạo, danh sách, sửa, tạm dừng, tiếp tục, xoá', async () => {
    const r = ok<{ id?: number; data?: { id: number } }>(
      await api.post('/social/recurrences', {
        ...t(),
        body: { title: 'Lặp hợp đồng', template: { content: 'Bài lặp', targets: [{ account_id: accountId }] }, rule: { freq: 'weekly', interval: 1, weekdays: [1], time: '09:00' }, starts_on: future(2).slice(0, 10) },
      }),
      201,
      'tạo bài lặp',
    )
    ok(await api.get('/social/recurrences', t()), 200, 'danh sách')
    ok(await api.patch(`/social/recurrences/${idOf(r)}`, { ...t(), body: { title: 'Lặp đã sửa' } }), 200, 'sửa')
    ok(await api.post(`/social/recurrences/${idOf(r)}/pause`, t()), 200, 'tạm dừng')
    ok(await api.post(`/social/recurrences/${idOf(r)}/resume`, t()), 200, 'tiếp tục')
    ok(await api.del(`/social/recurrences/${idOf(r)}`, t()), 204, 'xoá')
  })

  it('thống kê', async () => {
    ok(await api.get('/social/stats', t()), 200, 'thống kê')
  })
})
