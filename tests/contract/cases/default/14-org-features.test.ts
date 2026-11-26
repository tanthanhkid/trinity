import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser, setSetting } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { golden, snap } from '../../lib/golden.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/**
 * C08, từ `org-features.e2e-spec.ts` (4 ca). "Tính năng của tổ chức": GET = AuthOnly, PUT = `settings.features`; cập nhật một phần;
 * công tắc ĐỘC LẬP RBAC. Các ca chạy tuần tự trên cùng DB nên mỗi ca xoá khoá `org_features` ở đầu.
 */
const reset = async (): Promise<void> => {
  await q(`DELETE FROM settings WHERE key = 'org_features'`)
  // DB mới seed ở trạng thái "chưa dựng quy trình" (module cứng tắt theo mặc định); ca gốc chạy trên hệ thống đã dựng ⇒ bật hết.
  await setSetting('setup_status', 'da_dung')
  await control.flushCache()
}
const tok = async (u: Awaited<ReturnType<typeof seedUser>>): Promise<string> => (await loginSeeded(u)).token
const put = (t: string, body: unknown) => api.put('/settings/org-features', { token: t, body, ip: freshIp() })
const getFeatures = (t: string) => api.get('/settings/org-features', { token: t, ip: freshIp() })

describe('Org features', () => {
  it('GET không token → 401; user thường đọc được, mặc định bật hết', async () => {
    await reset()
    expect((await api.get('/settings/org-features', { ip: freshIp() })).status).toBe(401)
    const u = await seedUser({ label: 'reader', grants: {} })
    const res = await getFeatures(await tok(u))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ contacts: true, kanban: true })
    golden('org-features-default', 'sale', snap(res))
  })

  it('PUT thiếu settings.features → 403', async () => {
    await reset()
    const u = await seedUser({ label: 'no-features', grants: { 'settings.integrations': null } })
    expect((await put(await tok(u), { kanban: false })).status).toBe(403)
  })

  it('PUT có quyền → lưu một phần; người khác thấy ngay; giá trị rác → 400; khoá lạ không được lưu', async () => {
    await reset()
    const admin = await seedUser({ label: 'admin', grants: { 'settings.features': null } })
    const other = await seedUser({ label: 'other', grants: {} })
    const at = await tok(admin)
    expect((await put(at, { kanban: false })).status).toBe(200)
    expect((await put(at, { pos: false })).status).toBe(200)
    const res = await getFeatures(await tok(other))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ kanban: false, pos: false })
    golden('org-features-partial', 'sale', snap(res))
    // Khoá lạ: hộp đen chạy với cấu hình thật nên có thể trả 400 (forbidNonWhitelisted) hoặc nhận rồi bỏ qua; bắt buộc là KHÔNG lọt vào dữ liệu.
    const hack = await put(at, { hack: true })
    golden('org-features-unknown-key', 'sale', snap(hack))
    const after = await getFeatures(await tok(other))
    expect(after.body).not.toHaveProperty('hack')
    expect((await put(at, { kanban: 'no' })).status).toBe(400)
  })

  it('tắt kanban KHÔNG thay kiểm quyền: user thiếu kanban.view vẫn 403 ở API công việc', async () => {
    await reset()
    const admin = await seedUser({ label: 'admin2', grants: { 'settings.features': null } })
    expect((await put(await tok(admin), { kanban: false })).status).toBe(200)
    const u = await seedUser({ label: 'plain', grants: {} })
    const res = await api.get('/kanban/boards', { token: await tok(u), ip: freshIp() })
    expect(res.status).toBe(403)
    await reset()
  })
})
