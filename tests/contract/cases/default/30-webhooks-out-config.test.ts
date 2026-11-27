import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { golden, snap } from '../../lib/golden.js'
import { B, a, mk, resetWebhooks, st, encryptWithForeignKey, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)
beforeEach(resetWebhooks)

/**
 * C12a (hồ sơ `default`: cờ bật, có khoá, KHÔNG cho địa chỉ nội bộ), từ `webhooks-out.e2e-spec.ts`: quyền, DTO, danh mục sự kiện, SSRF.
 * Cờ tắt, thiếu khoá, khoá sai và ca gửi thật nằm ở hồ sơ riêng (xem README, bảng ánh xạ env → hồ sơ).
 */
const URL_OK = 'https://hooks.example.test/h'
const WEBHOOKS = { 'integrations.webhooks': true } as const

describe('quyền', () => {
  it('không có integrations.webhooks → 403 mọi route (dù cờ bật); chỉ ai_admin/ai_connect cũng 403', async () => {
    for (const g of [{}, { 'integrations.ai_admin': true }, { 'integrations.ai_connect': true }] as Record<string, true>[]) {
      const u = await mk(g)
      const t = u.token
      await st(a(t).get(`${B}/events`), 403)
      await st(a(t).get(`${B}/endpoints`), 403)
      await st(a(t).post(`${B}/endpoints`, { name: 'x', url: URL_OK, events: ['contact.created'] }), 403)
      await st(a(t).get(`${B}/endpoints/1`), 403)
      await st(a(t).patch(`${B}/endpoints/1`, { name: 'y' }), 403)
      await st(a(t).del(`${B}/endpoints/1`), 403)
      await st(a(t).post(`${B}/endpoints/1/rotate-secret`), 403)
      await st(a(t).post(`${B}/endpoints/1/test`), 403)
      await st(a(t).get(`${B}/deliveries`), 403)
      await st(a(t).post(`${B}/deliveries/00000000-0000-4000-8000-000000000000/retry`), 403)
    }
    await st(a().get(`${B}/endpoints`), 401)
  })

  it('DTO sai → 400; id không có → 404; id không phải số → 400', async () => {
    const u = await mk(WEBHOOKS)
    const t = u.token
    await st(a(t).post(`${B}/endpoints`, { name: '', url: URL_OK, events: ['contact.created'] }), 400)
    await st(a(t).post(`${B}/endpoints`, { name: 'x', url: 'không-phải-url', events: ['contact.created'] }), 400)
    await st(a(t).post(`${B}/endpoints`, { name: 'x', url: URL_OK, events: [] }), 400)
    await st(a(t).post(`${B}/endpoints`, { name: 'x', url: URL_OK, events: ['nope'] }), 400)
    await st(a(t).post(`${B}/endpoints`, { name: 'x', url: URL_OK, events: ['contact.created'], extra: 1 }), 400)
    const missing = await st(a(t).get(`${B}/endpoints/99999`), 404)
    golden('webhooks-endpoint-not-found', 'admin', snap(missing))
    await st(a(t).get(`${B}/endpoints/abc`), 400)
    await st(a(t).get(`${B}/deliveries`, { status: 'zzz' }), 400)
    await st(a(t).post(`${B}/deliveries/00000000-0000-4000-8000-000000000000/retry`), 404)
  })

  it('danh mục sự kiện', async () => {
    const u = await mk(WEBHOOKS)
    const res = await st(a(u.token).get(`${B}/events`), 200)
    golden('webhooks-events', 'admin', snap(res))
    const types = (res.body as Body[]).map((e: { type: string }) => e.type)
    expect(types).toContain('pos.order.completed')
    // e2e gốc khẳng định 15; danh mục hiện có nhiều hơn (spec gốc đã cũ). Hợp đồng là danh mục `server/contracts/events.json`.
    const catalog = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../server/contracts/events.json'), 'utf8')) as { event_types: string[] }
    expect(types).toEqual(catalog.event_types)
  })
})

describe('SSRF: URL bị chặn khi tạo/sửa (không có cờ cho phép địa chỉ nội bộ)', () => {
  it.each([
    'http://example.com/h', 'https://127.0.0.1/h', 'https://localhost/h', 'https://[::1]/h', 'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/h', 'https://2130706433/h', 'https://0x7f.1/h', 'https://[::ffff:7f00:1]/h', 'https://user:pw@example.com/h', 'https://example.com:5432/h',
  ])('chặn %s', async (bad) => {
    const u = await mk(WEBHOOKS)
    const res = await st(a(u.token).post(`${B}/endpoints`, { name: 'x', url: bad, events: ['contact.created'] }), 400)
    expect((await q(`SELECT 1 FROM webhook_endpoints`)).length, 'không tạo endpoint').toBe(0)
    golden(`webhooks-ssrf-${bad.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}`, 'admin', snap(res))
  })

  it('sửa URL sang địa chỉ nội bộ → 400, URL cũ giữ nguyên', async () => {
    const u = await mk(WEBHOOKS)
    // Endpoint trỏ về máy cục bộ chỉ tồn tại khi đường tạo cho phép địa chỉ nội bộ (hồ sơ khác): ở đây seed bằng SQL như dữ liệu cũ.
    const old = 'http://127.0.0.1:9/hook'
    const [ep] = await q<{ id: number }>(
      `INSERT INTO webhook_endpoints (name, url, secret_enc, events, created_by, updated_at) VALUES ('cũ', $1, $2, ARRAY['contact.created'], $3, now()) RETURNING id`,
      [old, encryptWithForeignKey('whsec_x'), u.id],
    )
    await st(a(u.token).patch(`${B}/endpoints/${ep.id}`, { url: 'https://169.254.169.254/x' }), 400)
    expect((await q<{ url: string }>(`SELECT url FROM webhook_endpoints WHERE id = $1`, [ep.id]))[0].url).toBe(old)
  })
})
