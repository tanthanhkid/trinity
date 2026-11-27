import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { loginAdmin } from '../../lib/session.js'
import { a, mk, st, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)
beforeEach(async () => {
  await q(`TRUNCATE TABLE integration_events, integration_audit_logs RESTART IDENTITY`)
})

/**
 * C12b, từ `apps/monolith/test/rbac/integrations.e2e-spec.ts` nhóm "quyền + cờ" (5 ca ở đây). Hồ sơ `default`: cờ webhook và MCP đều BẬT,
 * có khoá mã hoá (e2e gốc đặt/xoá `INTEGRATIONS_*` giữa ca; ca cờ tắt ở `integrations-off/`). Ca che SĐT/secret của `IntegrationAuditService.log`
 * thành bảng ca dùng chung `server/contracts/cases/audit-sanitize.json` (spec TS `audit-sanitize-cases.spec.ts`).
 */
describe('Kết nối & AI: quyền, trạng thái, nhật ký', () => {
  it('không có quyền nhóm Kết nối & AI → 403 cả status lẫn audit-logs', async () => {
    const u = await mk({})
    await st(a(u.token).get('/integrations/status'), 403)
    await st(a(u.token).get('/integrations/audit-logs'), 403)
  })

  it('chỉ ai_connect hoặc webhooks: đọc được status, KHÔNG đọc được nhật ký toàn công ty (cần ai_admin) → 403', async () => {
    for (const perm of ['integrations.ai_connect', 'integrations.webhooks'] as const) {
      const u = await mk({ [perm]: true })
      await st(a(u.token).get('/integrations/status'), 200)
      await st(a(u.token).get('/integrations/audit-logs'), 403)
    }
  })

  it('cờ bật + ai_admin: 200, lọc kênh/trạng thái, phân trang cursor, tham số sai → 400', async () => {
    const u = await mk({ 'integrations.ai_admin': true })
    // e2e gốc ghi bằng `IntegrationAuditService.log`; hộp đen seed dòng nhật ký bằng SQL (mới → cũ theo created_at).
    for (let i = 0; i < 3; i++) await q(`INSERT INTO integration_audit_logs (channel, action, status, user_id, created_at) VALUES ('mcp', $1, 'ok', $2, now() - ($3 || ' seconds')::interval)`, [`tool_${i}`, u.id, String(10 - i)])
    await q(`INSERT INTO integration_audit_logs (channel, action, status, http_status, created_at) VALUES ('webhook_out', 'contact.created', 'error', 500, now())`)

    const s = (await st(a(u.token).get('/integrations/status'), 200)).body as Body
    expect(s).toMatchObject({ webhooks_enabled: true, mcp_enabled: true, secret_key_configured: true })

    const all = (await st(a(u.token).get('/integrations/audit-logs'), 200)).body as Body
    expect(all.data).toHaveLength(4)
    expect(all.meta.next_cursor).toBeNull()
    expect(all.data[0].action).toBe('contact.created') // mới → cũ

    const mcp = (await st(a(u.token).get('/integrations/audit-logs', { channel: 'mcp', status: 'ok' }), 200)).body as Body
    expect(mcp.data.map((r: { channel: string }) => r.channel)).toEqual(['mcp', 'mcp', 'mcp'])

    const p1 = (await st(a(u.token).get('/integrations/audit-logs', { limit: '3' }), 200)).body as Body
    expect(p1.data).toHaveLength(3)
    const p2 = (await st(a(u.token).get('/integrations/audit-logs', { limit: '3', cursor: p1.meta.next_cursor }), 200)).body as Body
    expect(p2.data).toHaveLength(1)
    const ids = [...p1.data, ...p2.data].map((r: { id: string }) => r.id)
    expect(new Set(ids).size).toBe(4)

    await st(a(u.token).get('/integrations/audit-logs', { channel: 'sms' }), 400)
    await st(a(u.token).get('/integrations/audit-logs', { limit: '9999' }), 400)
    await st(a(u.token).get('/integrations/audit-logs', { cursor: 'abc' }), 400)
  })

  it('vai trò hệ thống Quản trị tự có đủ 3 quyền mới', async () => {
    const admin = await loginAdmin()
    const t = { token: admin.token, ip: freshIp() }
    await st(api.get('/integrations/status', t), 200)
    await st(api.get('/integrations/audit-logs', { ...t, ip: freshIp() }), 200)
    const me = (await st(api.get('/auth/me', { ...t, ip: freshIp() }), 200)).body as Body
    for (const k of ['integrations.webhooks', 'integrations.ai_connect', 'integrations.ai_admin']) expect(me.permissions[k]).toBe(true)
    const cat = (await st(api.get('/rbac/catalog', { ...t, ip: freshIp() }), 200)).body as Body
    const defs = cat.permissions as Array<{ key: string; group: string }>
    // Nhóm có thể có thêm quyền sau e2e gốc (catalog đã đóng băng ở rbac.json): kiểm đủ 3 quyền gốc, không kiểm bằng tuyệt đối.
    expect(defs.filter((d) => d.group === 'Kết nối & AI').map((d) => d.key)).toEqual(expect.arrayContaining(['integrations.ai_admin', 'integrations.ai_connect', 'integrations.webhooks']))
  })

  it('org-feature "integrations" là khoá hợp lệ của PUT /settings/org-features', async () => {
    const u = await mk({ 'settings.features': true })
    const put = (b: object) => api.put('/settings/org-features', { token: u.token, body: b, ip: freshIp() })
    const res = await st(put({ integrations: false }), 200)
    expect((res.body as Body).integrations).toBe(false)
    await st(put({ integrations: true }), 200)
  })
})
