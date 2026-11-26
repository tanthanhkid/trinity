import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser, type SeededUser } from '../../lib/db.js'
import { api, call, freshIp } from '../../lib/http.js'
import { loginAdmin, loginSeeded } from '../../lib/session.js'

const made: SeededUser[] = []
const mk = async (o: Parameters<typeof seedUser>[0]) => {
  const u = await seedUser(o)
  made.push(u)
  return u
}

/** Dọn mọi dòng file này seed để DB dùng chung không dính rác sang ca khác. */
afterAll(async () => {
  await q(`DELETE FROM contacts WHERE phone = '0971100217'`)
  await q(`DELETE FROM products WHERE code LIKE 'c11-%'`)
  await q(`DELETE FROM notification_logs WHERE recipient_id = ANY($1)`, [made.map((u) => u.id)])
  await closeDb()
})

/** Chuyển từ `apps/monolith/test/rbac/commerce.e2e-spec.ts` (5 ca): sản phẩm, danh mục, thuộc tính, dự án. Mã sản phẩm có tiền tố `c11-` để không trùng ca khác. */
const opts = async (u: SeededUser) => ({ token: (await loginSeeded(u)).token, ip: freshIp() })

describe('commerce: sản phẩm, danh mục, dự án', () => {
  let none: SeededUser
  let viewer: SeededUser
  let mgr: SeededUser
  let manageOnly: SeededUser
  beforeAll(async () => {
    none = await mk({ label: 'none', grants: {} })
    viewer = await mk({ label: 'viewer', grants: { 'products.view': null } })
    mgr = await mk({ label: 'mgr', grants: { 'products.manage': null, 'products.view': null } })
    manageOnly = await mk({ label: 'manage-only', grants: { 'products.manage': null } })
  })

  it('health @Public → 200 không token', async () => {
    const res = await call('GET', '/api/v1/health', { ip: freshIp() })
    expect(res.status).toBe(200)
  })

  it('GET: thiếu products.view → 403; có → 200; id không tồn tại → 404', async () => {
    for (const url of ['/products', '/product-categories', '/projects']) {
      expect((await api.get(url, await opts(none))).status, `none ${url}`).toBe(403)
      expect((await api.get(url, await opts(viewer))).status, `viewer ${url}`).toBe(200)
    }
    expect((await api.get('/products/999999', await opts(viewer))).status).toBe(404)
    expect((await api.get('/projects/999999', await opts(viewer))).status).toBe(404)
  })

  it('ghi: products.view không đủ → 403 trên mọi route ghi', async () => {
    const t = async () => opts(viewer)
    expect((await api.post('/products', { ...(await t()), body: { code: 'c11-ab-1', name: 'Sản phẩm' } })).status).toBe(403)
    expect((await api.patch('/products/1', { ...(await t()), body: { name: 'x' } })).status).toBe(403)
    expect((await api.del('/products/1', await t())).status).toBe(403)
    expect((await api.post('/product-categories', { ...(await t()), body: { code: 'c11-c1', name: 'Danh mục' } })).status).toBe(403)
    expect((await api.patch('/product-attribute-defs/1', { ...(await t()), body: {} })).status).toBe(403)
    expect((await api.del('/product-attribute-defs/1', await t())).status).toBe(403)
    expect((await api.post('/projects', { ...(await t()), body: { name: 'Dự án', code: 'c11-da1' } })).status).toBe(403)
    expect((await api.del('/projects/1', await t())).status).toBe(403)
  })

  it('products.manage: tạo sản phẩm thành công; sửa/xoá id không tồn tại → 404', async () => {
    const created = await api.post('/products', { ...(await opts(manageOnly)), body: { code: 'c11-ab-2', name: 'Sản phẩm hai' } })
    expect(created.status).toBe(201)
    expect((await api.patch('/products/999999', { ...(await opts(manageOnly)), body: { name: 'xx' } })).status).toBe(404)
    expect((await api.del('/projects/999999', await opts(manageOnly))).status).toBe(404)
  })

  // Bản e2e cũ gọi `DELETE /products/:id` kỳ vọng xoá hẳn/409; route đó nay là lưu trữ (xoá mềm), xoá hẳn là `DELETE /products/:id/permanent`
  // (chỉ Quản trị). Ca giữ nguyên ý (xoá hẳn khi chưa tham chiếu; 409 khi liên hệ đang gắn) trên route hiện hành.
  it('xoá: DELETE /products/:id lưu trữ; /permanent chỉ Quản trị, xoá hẳn khi chưa tham chiếu, 409 khi liên hệ đang gắn', async () => {
    const admin = async () => ({ token: (await loginAdmin()).token, ip: freshIp() })
    const archived = await api.post('/products', { ...(await opts(mgr)), body: { code: 'c11-del-0', name: 'Lưu trữ' } })
    const archivedId = (archived.body as { id: number }).id
    expect((await api.del(`/products/${archivedId}`, await opts(mgr))).status).toBe(200)
    expect((await api.get(`/products/${archivedId}`, await opts(mgr))).status).toBe(404)

    const free = await api.post('/products', { ...(await opts(mgr)), body: { code: 'c11-del-1', name: 'Xoá được' } })
    expect(free.status).toBe(201)
    const freeId = (free.body as { id: number }).id
    expect((await api.del(`/products/${freeId}/permanent`, await opts(mgr))).status).toBe(403)
    expect((await api.del(`/products/${freeId}/permanent`, await admin())).status).toBe(200)
    expect((await api.get(`/products/${freeId}`, await opts(mgr))).status).toBe(404)

    const used = await api.post('/products', { ...(await opts(mgr)), body: { code: 'c11-del-2', name: 'Đã dùng' } })
    expect(used.status).toBe(201)
    const usedId = (used.body as { id: number }).id
    const [contact] = await q<{ id: number }>(
      `INSERT INTO contacts (phone, product_id, created_at, updated_at) VALUES ('0971100217', $1, now(), now()) RETURNING id`,
      [usedId],
    )
    try {
      const res = await api.del(`/products/${usedId}/permanent`, await admin())
      expect(res.status).toBe(409)
      expect((res.body as { message: string }).message).toContain('chỉ có thể ẩn')
      expect((await api.get(`/products/${usedId}`, await opts(mgr))).status).toBe(200)
    } finally {
      await q(`DELETE FROM contacts WHERE id = $1`, [contact.id])
    }
  })
})
