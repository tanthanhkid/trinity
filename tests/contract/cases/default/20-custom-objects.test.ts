import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { ALL, BASE, a, count, getBytes, mk, postRaw, resetCustom, roleOf, st, type Body, type U } from '../../lib/custom.js'
import { golden, snap } from '../../lib/golden.js'
import { goldenThreeRoles } from '../../lib/roles.js'

afterAll(closeDb)
beforeEach(resetCustom)

/**
 * C09, từ `apps/monolith/test/rbac/custom-objects.e2e-spec.ts` (14 ca). Thực thể tuỳ biến: ma trận quyền + phạm vi, validate theo định
 * nghĩa trường, công thức, liên kết, lọc/sắp xếp/cursor, che SĐT (quyền riêng `custom_records.phone_full`), xuất CSV, outbox sự kiện.
 */
async function mkObject(token: string, key = 'hoc_sinh', body: Record<string, unknown> = {}): Promise<Body> {
  return (await st(a(token).post(BASE, { key, label: 'Học sinh', label_plural: 'Học sinh', ...body }), 201)).body
}
async function mkField(token: string, key: string, body: Record<string, unknown>): Promise<Body> {
  return (await st(a(token).post(`${BASE}/${key}/fields`, body), 201)).body
}
const rec = (token: string, key: string, data: Record<string, unknown>, owner?: number) =>
  a(token).post(`${BASE}/${key}/records`, owner ? { data, owner_id: owner } : { data })

describe('Thực thể tuỳ biến', () => {
  it('401 không token; 403 khi thiếu quyền ở MỌI route', async () => {
    await st(a().get(`${BASE}/nav`), 401)
    const none = await mk({})
    const t = none.token
    await st(a(t).get(BASE), 403)
    await st(a(t).post(BASE, { key: 'a', label: 'A', label_plural: 'A' }), 403)
    await st(a(t).get(`${BASE}/nav`), 403)
    await st(a(t).get(`${BASE}/x`), 403)
    await st(a(t).patch(`${BASE}/x`, {}), 403)
    await st(a(t).del(`${BASE}/x`), 403)
    await st(a(t).post(`${BASE}/x/fields`, { label: 'A', type: 'text' }), 403)
    await st(a(t).get(`${BASE}/x/records`), 403)
    await st(a(t).post(`${BASE}/x/records`, { data: {} }), 403)
    await st(a(t).get(`${BASE}/x/records/1`), 403)
    await st(a(t).patch(`${BASE}/x/records/1`, { data: {} }), 403)
    await st(a(t).del(`${BASE}/x/records/1`), 403)
    await st(a(t).get(`${BASE}/x/records/export`), 403)
    await st(a(t).get(`${BASE}/x/lookup`), 403)
    await st(a(t).get(`${BASE}/lookup/users`), 403)
    await st(a(t).post(`${BASE}/formula/preview`, { object_key: 'x', expression: '1' }), 403)
    // chỉ view: không cấu hình được
    const viewer = await mk({ 'custom_records.view': 'all' })
    await st(a(viewer.token).post(BASE, { key: 'a', label: 'A', label_plural: 'A' }), 403)
    await st(a(viewer.token).get(`${BASE}/nav`), 200)
  })

  it('tạo thực thể: kiểm key / icon / vai trò / trùng; mặc định; sửa; nav', async () => {
    const t = (await mk(ALL)).token
    await st(a(t).post(BASE, { key: 'Hoc Sinh', label: 'A', label_plural: 'A' }), 400)
    await st(a(t).post(BASE, { key: 'nav', label: 'A', label_plural: 'A' }), 400)
    await st(a(t).post(BASE, { key: 'ok', label: 'A', label_plural: 'A', icon: 'rocket-evil' }), 400)
    await st(a(t).post(BASE, { key: 'ok', label: 'A', label_plural: 'A', visible_role_ids: [999999] }), 400)
    await st(a(t).post(BASE, { key: 'ok', label: 'A', label_plural: 'A', hack: 1 }), 400)
    const o = await mkObject(t, 'hoc_sinh', { icon: 'graduation-cap' })
    expect(o).toMatchObject({ key: 'hoc_sinh', show_in_nav: true, is_active: true, visible_role_ids: [] })
    golden('custom-object-created', 'admin', snap({ status: 201, headers: new Headers(), body: o }))
    await st(a(t).post(BASE, { key: 'hoc_sinh', label: 'B', label_plural: 'B' }), 409)
    await st(a(t).patch(`${BASE}/hoc_sinh`, { label: 'Học viên', key: 'khac' }), 400)
    const u = await st(a(t).patch(`${BASE}/hoc_sinh`, { label: 'Học viên' }), 200)
    expect((u.body as Body).label).toBe('Học viên')
    const nav = await st(a(t).get(`${BASE}/nav`), 200)
    expect(nav.body).toEqual([expect.objectContaining({ key: 'hoc_sinh', label: 'Học viên', icon: 'graduation-cap' })])
    await st(a(t).patch(`${BASE}/hoc_sinh`, { show_in_nav: false }), 200)
    expect((await st(a(t).get(`${BASE}/nav`), 200)).body).toEqual([])
  })

  it('visible_role_ids chỉ THU HẸP: người ngoài vai trò → 404 + không có trong menu; người giữ manage vẫn thấy; không cấp thêm quyền', async () => {
    const admin = await mk(ALL)
    const inRole = await mk({ 'custom_records.view': 'all' })
    const outRole = await mk({ 'custom_records.view': 'all' })
    const roleId = await roleOf(inRole.id)
    await mkObject(admin.token, 'bi_mat', { visible_role_ids: [roleId] })
    expect((await st(a(inRole.token).get(`${BASE}/nav`), 200)).body).toHaveLength(1)
    await st(a(inRole.token).get(`${BASE}/bi_mat`), 200)
    expect((await st(a(outRole.token).get(`${BASE}/nav`), 200)).body).toHaveLength(0)
    await st(a(outRole.token).get(`${BASE}/bi_mat`), 404)
    await st(a(outRole.token).get(`${BASE}/bi_mat/records`), 404)
    expect(((await st(a(admin.token).get(`${BASE}/bi_mat`), 200)).body as Body).key).toBe('bi_mat')
    // vai trò có trong danh sách nhưng KHÔNG có quyền xem dữ liệu → vẫn 403 (không cấp thêm quyền)
    const noPerm = await mk({})
    const noPermRole = await roleOf(noPerm.id)
    await st(a(admin.token).patch(`${BASE}/bi_mat`, { visible_role_ids: [noPermRole] }), 200)
    await st(a(noPerm.token).get(`${BASE}/bi_mat/records`), 403)
    // tắt thực thể: người thường 404, quản trị vẫn thấy
    await st(a(admin.token).patch(`${BASE}/bi_mat`, { visible_role_ids: [], is_active: false }), 200)
    await st(a(inRole.token).get(`${BASE}/bi_mat/records`), 404)
    await st(a(admin.token).get(`${BASE}/bi_mat/records`), 200)
  })

  it('trường: kiểm kiểu, select cần lựa chọn, tiêu đề tự gán, khoá bất biến, công thức sai bị từ chối', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t)
    const f1 = await mkField(t, 'hoc_sinh', { label: 'Họ và tên', type: 'text', required: true })
    expect(f1).toMatchObject({ key: 'ho_va_ten', is_title: true, required: true })
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'Họ và tên', type: 'text' }), 409)
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'X', type: 'khong_co' }), 400)
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'Giới tính', type: 'select' }), 400)
    const sel = await mkField(t, 'hoc_sinh', { label: 'Giới tính', type: 'select', options: { choices: [{ label: 'Nam' }, { label: 'Nữ' }] } })
    expect(sel.options.choices.map((c: { value: string }) => c.value)).toEqual(['nam', 'nu'])
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'Cv', type: 'formula', options: { expression: 'process.exit(1)' } }), 400)
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'Cv', type: 'formula', options: { expression: '{khong_co}*2' } }), 400)
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'Cv', type: 'text', is_unique: true, required: true }), 201)
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'Mô tả', type: 'long_text', is_unique: true }), 400)
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'Mã', type: 'phone', is_title: true }), 400)
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'Rel', type: 'relation', options: { target_object_id: 9999 } }), 400)
    await st(a(t).patch(`${BASE}/hoc_sinh/fields/ho_va_ten`, { key: 'doi_khoa' }), 400)
    await st(a(t).del(`${BASE}/hoc_sinh/fields/ho_va_ten`), 409) // đang là tiêu đề
    const detail = (await st(a(t).get(`${BASE}/hoc_sinh`), 200)).body as Body
    expect(detail.fields.filter((f: { is_title: boolean }) => f.is_title)).toHaveLength(1)
  })

  it('bản ghi: validate kiểu/bắt buộc/duy nhất/lựa chọn/SĐT/email/url/ngày/tiền, trường lạ, công thức không nhập được', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t)
    await mkField(t, 'hoc_sinh', { label: 'Họ tên', key: 'ten', type: 'text', required: true })
    await mkField(t, 'hoc_sinh', { label: 'Mã', key: 'ma', type: 'text', is_unique: true })
    await mkField(t, 'hoc_sinh', { label: 'Giới tính', key: 'gt', type: 'select', options: { choices: [{ label: 'Nam', value: 'nam' }, { label: 'Nữ', value: 'nu' }] } })
    await mkField(t, 'hoc_sinh', { label: 'Sở thích', key: 'st', type: 'multi_select', options: { choices: [{ label: 'Vẽ', value: 've' }, { label: 'Đá bóng', value: 'bong' }] } })
    await mkField(t, 'hoc_sinh', { label: 'SĐT', key: 'sdt', type: 'phone' })
    await mkField(t, 'hoc_sinh', { label: 'Email', key: 'em', type: 'email' })
    await mkField(t, 'hoc_sinh', { label: 'Web', key: 'web', type: 'url' })
    await mkField(t, 'hoc_sinh', { label: 'Sinh', key: 'sinh', type: 'date' })
    await mkField(t, 'hoc_sinh', { label: 'Phí', key: 'phi', type: 'currency' })
    await mkField(t, 'hoc_sinh', { label: 'Giảm', key: 'giam', type: 'percent' })
    await mkField(t, 'hoc_sinh', { label: 'Đã học', key: 'da', type: 'boolean' })
    await mkField(t, 'hoc_sinh', { label: 'Tính', key: 'tinh', type: 'formula', options: { expression: '{phi}*(1-{giam})', format: 'currency' } })

    const bad = async (data: Record<string, unknown>, key: string): Promise<void> => {
      const r = await st(rec(t, 'hoc_sinh', { ten: 'A', ...data }), 400)
      expect(Object.keys((r.body as Body).errors)).toContain(key)
    }
    await st(rec(t, 'hoc_sinh', {}), 400)
    await bad({ gt: 'khac' }, 'gt')
    await bad({ st: ['ve', 'xxx'] }, 'st')
    await bad({ sdt: '123' }, 'sdt')
    await bad({ em: 'khong-phai-email' }, 'em')
    await bad({ web: 'javascript:alert(1)' }, 'web')
    await bad({ sinh: '2025-02-30' }, 'sinh')
    await bad({ phi: 1.5 }, 'phi')
    await bad({ giam: 5000 }, 'giam')
    await bad({ tinh: 5 }, 'tinh')
    await bad({ khong_ton_tai: 1 }, 'khong_ton_tai')
    // khoá `constructor` bị class-transformer bỏ trước khi vào service (không bao giờ được lưu, không ném 500)
    const sneaky = await st(postRaw(`${BASE}/hoc_sinh/records`, t, '{"data":{"ten":"S","constructor":2,"__proto__":{"x":1}}}'), 201)
    expect(Object.keys((sneaky.body as Body).data).sort()).toEqual(['ten', 'tinh'])
    await bad({ da: 'maybe' }, 'da')

    const ok = await st(rec(t, 'hoc_sinh', { ten: ' Học sinh Mẫu 01 ', ma: 'HS01', gt: 'nam', st: ['ve'], sdt: '+84 912 345 678', em: 'A@X.VN', web: 'https://x.vn', sinh: '2015-05-20', phi: 9_600_000, giam: 5, da: true }), 201)
    const okBody = ok.body as Body
    expect(okBody.title).toBe('Học sinh Mẫu 01')
    expect(okBody.data).toMatchObject({ sdt: '0912345678', em: 'a@x.vn', tinh: 9_120_000 })
    // duy nhất (không phân biệt hoa-thường), cả khi sửa sang giá trị của bản khác
    const dup = await st(rec(t, 'hoc_sinh', { ten: 'B', ma: 'hs01' }), 400)
    expect((dup.body as Body).errors.ma).toMatch(/đã tồn tại/)
    const b = await st(rec(t, 'hoc_sinh', { ten: 'B', ma: 'HS02' }), 201)
    await st(a(t).patch(`${BASE}/hoc_sinh/records/${(b.body as Body).id}`, { data: { ma: 'HS01' } }), 400)
    // sửa một phần giữ nguyên phần còn lại; null xoá giá trị; xoá trường bắt buộc → 400
    const p = await st(a(t).patch(`${BASE}/hoc_sinh/records/${okBody.id}`, { data: { phi: 1_000_000, gt: null } }), 200)
    expect((p.body as Body).data).toMatchObject({ ten: 'Học sinh Mẫu 01', phi: 1_000_000, tinh: 950_000 })
    expect((p.body as Body).data.gt).toBeUndefined()
    await st(a(t).patch(`${BASE}/hoc_sinh/records/${okBody.id}`, { data: { ten: null } }), 400)
    // đổi kiểu trường có dữ liệu / bỏ lựa chọn đang dùng → 409
    await st(a(t).patch(`${BASE}/hoc_sinh/fields/phi`, { type: 'date' }), 409)
    await st(a(t).patch(`${BASE}/hoc_sinh/fields/st`, { options: { choices: [{ label: 'Đá bóng', value: 'bong' }] } }), 409)
    await st(a(t).patch(`${BASE}/hoc_sinh/fields/phi`, { type: 'number' }), 409)
    await st(a(t).del(`${BASE}/hoc_sinh/fields/phi`), 409) // công thức `tinh` đang dùng
    await st(a(t).del(`${BASE}/hoc_sinh/fields/tinh`), 200)
    await st(a(t).del(`${BASE}/hoc_sinh/fields/phi`), 200)
    // khoá cũ còn dữ liệu → không tạo lại trùng khoá
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { key: 'phi', label: 'Phí mới', type: 'text' }), 409)
  })

  it('công thức: tính theo ngày/tiền, xem trước, thiếu dữ liệu → null', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t, 'ghi_danh')
    await mkField(t, 'ghi_danh', { label: 'Mã', key: 'ma', type: 'text' })
    await mkField(t, 'ghi_danh', { label: 'Bắt đầu', key: 'bat_dau', type: 'date' })
    await mkField(t, 'ghi_danh', { label: 'Kết thúc', key: 'ket_thuc', type: 'date' })
    await mkField(t, 'ghi_danh', { label: 'Thực tế (tháng)', key: 'thuc_te', type: 'formula', options: { expression: 'round(months_between({bat_dau}, {ket_thuc}), 1)' } })
    const pv = await st(a(t).post(`${BASE}/formula/preview`, { object_key: 'ghi_danh', expression: 'months_between({bat_dau},{ket_thuc})', sample: { bat_dau: '2025-01-01', ket_thuc: '2025-04-01' } }), 201)
    expect(pv.body).toEqual({ ok: true, result: 3 })
    const bad = await st(a(t).post(`${BASE}/formula/preview`, { object_key: 'ghi_danh', expression: '{ma}+1' }), 201)
    expect((bad.body as Body).ok).toBe(false)
    const r = await st(rec(t, 'ghi_danh', { ma: 'GD1', bat_dau: '2025-01-01', ket_thuc: '2025-02-16' }), 201)
    expect((r.body as Body).data.thuc_te).toBe(1.5)
    const r2 = await st(rec(t, 'ghi_danh', { ma: 'GD2', bat_dau: '2025-01-01' }), 201)
    expect((r2.body as Body).data.thuc_te).toBeNull()
  })

  it('phạm vi: scope own chỉ thấy/sửa/xoá bản ghi của mình (owner ∪ người tạo), ngoài phạm vi theo id → 404; giao người phụ trách phải trong phạm vi', async () => {
    const admin = await mk(ALL)
    const boss = await mk({ 'custom_records.view': 'subtree', 'custom_records.manage': 'subtree', 'custom_records.delete': 'subtree' })
    const own = { 'custom_records.view': 'own', 'custom_records.manage': 'own', 'custom_records.delete': 'own' } as const
    const u1 = await mk(own, { managerId: boss.id })
    const u2 = await mk(own, { managerId: boss.id })
    await mkObject(admin.token)
    await mkField(admin.token, 'hoc_sinh', { label: 'Tên', key: 'ten', type: 'text' })
    const ra = (await st(rec(u1.token, 'hoc_sinh', { ten: 'của A' }), 201)).body as Body
    const rb = (await st(rec(u2.token, 'hoc_sinh', { ten: 'của B' }), 201)).body as Body
    expect(ra.owner_id).toBe(u1.id)
    const la = (await st(a(u1.token).get(`${BASE}/hoc_sinh/records`), 200)).body as Body
    expect(la.items.map((x: { id: number }) => x.id)).toEqual([ra.id])
    expect(la.total).toBe(1)
    expect(((await st(a(boss.token).get(`${BASE}/hoc_sinh/records`), 200)).body as Body).total).toBe(2)
    expect(((await st(a(admin.token).get(`${BASE}/hoc_sinh/records`), 200)).body as Body).total).toBe(2)
    await st(a(u1.token).get(`${BASE}/hoc_sinh/records/${rb.id}`), 404)
    await st(a(u1.token).patch(`${BASE}/hoc_sinh/records/${rb.id}`, { data: { ten: 'hack' } }), 404)
    await st(a(u1.token).del(`${BASE}/hoc_sinh/records/${rb.id}`), 404)
    await st(a(u1.token).get(`${BASE}/hoc_sinh/records/${rb.id}/related`), 404)
    // giao cho người ngoài phạm vi → 400; cấp trên giao xuống cấp dưới được
    await st(rec(u1.token, 'hoc_sinh', { ten: 'x' }, u2.id), 400)
    const giao = await st(rec(boss.token, 'hoc_sinh', { ten: 'boss giao' }, u1.id), 201)
    await st(a(u1.token).get(`${BASE}/hoc_sinh/records/${(giao.body as Body).id}`), 200) // owner = u1
    // chỉ view: không ghi
    const viewer = await mk({ 'custom_records.view': 'all' })
    await st(rec(viewer.token, 'hoc_sinh', { ten: 'x' }), 403)
    await st(a(viewer.token).del(`${BASE}/hoc_sinh/records/${ra.id}`), 403)
    await st(a(u1.token).del(`${BASE}/hoc_sinh/records/${ra.id}`), 200)
    await st(a(u1.token).get(`${BASE}/hoc_sinh/records/${ra.id}`), 404)
  })

  it('SĐT: che theo custom_records.phone_full RIÊNG (contacts.phone_full không mở), mọi đường ra (list/detail/export/lookup)', async () => {
    const admin = await mk(ALL)
    await mkObject(admin.token, 'phu_huynh')
    await mkField(admin.token, 'phu_huynh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(admin.token, 'phu_huynh', { label: 'SĐT', key: 'sdt', type: 'phone' })
    const r = (await st(rec(admin.token, 'phu_huynh', { ten: 'PH Mẫu', sdt: '0900000123' }), 201)).body as Body
    expect(r.data.sdt).toBe('0900000123')
    const other = await mk({ 'custom_records.view': 'all', 'custom_records.export': 'all', 'contacts.phone_full': 'all' })
    const masked = (await goldenThreeRoles('custom-record-phone-detail', `${BASE}/phu_huynh/records/${r.id}`, other.token)).body as Body
    expect(masked.data.sdt).toBe('***123')
    const list = await goldenThreeRoles('custom-record-phone-list', `${BASE}/phu_huynh/records`, other.token)
    expect((list.body as Body).items[0].data.sdt).toBe('***123')
    const csv = String((await st(a(other.token).get(`${BASE}/phu_huynh/records/export`), 200)).body)
    expect(csv).toContain('***123')
    expect(csv).not.toContain('0900000123')
    const full = await mk({ 'custom_records.view': 'all', 'custom_records.phone_full': 'all' })
    expect(((await st(a(full.token).get(`${BASE}/phu_huynh/records/${r.id}`), 200)).body as Body).data.sdt).toBe('0900000123')
    // không lọc / sắp xếp theo SĐT (chống dò từng chữ số)
    await st(a(other.token).get(`${BASE}/phu_huynh/records`, { filter: JSON.stringify({ sdt: '0900' }) }), 400)
    await st(a(other.token).get(`${BASE}/phu_huynh/records`, { sort: 'field:sdt' }), 400)
  })

  it('liên kết: chỉ chọn/đọc bản ghi TRONG phạm vi; tiêu đề ngoài phạm vi không lộ; tra cứu chỉ {id,title}; bản ghi liên quan ngược', async () => {
    const admin = await mk(ALL)
    const u = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'own' })
    await mkObject(admin.token, 'phu_huynh')
    await mkField(admin.token, 'phu_huynh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(admin.token, 'phu_huynh', { label: 'SĐT', key: 'sdt', type: 'phone' })
    await mkObject(admin.token, 'hoc_sinh')
    await mkField(admin.token, 'hoc_sinh', { label: 'Tên', key: 'ten', type: 'text' })
    const ph = (await mkObject(admin.token, 'ban_nhap')).id
    expect(ph).toBeGreaterThan(0)
    const phObj = (await st(a(admin.token).get(`${BASE}/phu_huynh`), 200)).body as Body
    await mkField(admin.token, 'hoc_sinh', { label: 'Phụ huynh', key: 'phu_huynh', type: 'relation', options: { target_object_id: phObj.id } })
    await mkField(admin.token, 'hoc_sinh', { label: 'Người lo', key: 'nguoi', type: 'user' })
    const pOfA = (await st(rec(u.token, 'phu_huynh', { ten: 'PH của A', sdt: '0900000111' }), 201)).body as Body
    const pOfAdmin = (await st(rec(admin.token, 'phu_huynh', { ten: 'PH bí mật', sdt: '0900000222' }), 201)).body as Body
    // A không chọn được bản ghi ngoài phạm vi; id không tồn tại cũng vậy
    const e1 = await st(rec(u.token, 'hoc_sinh', { ten: 'HS', phu_huynh: pOfAdmin.id }), 400)
    expect((e1.body as Body).errors.phu_huynh).toBeDefined()
    await st(rec(u.token, 'hoc_sinh', { ten: 'HS', phu_huynh: 999999 }), 400)
    await st(rec(u.token, 'hoc_sinh', { ten: 'HS', nguoi: 999999 }), 400)
    const hs = (await st(rec(u.token, 'hoc_sinh', { ten: 'HS của A', phu_huynh: pOfA.id, nguoi: u.id }), 201)).body as Body
    expect(hs.relations.phu_huynh).toEqual({ id: pOfA.id, title: 'PH của A', accessible: true })
    expect(hs.relations.nguoi.accessible).toBe(true)
    // Admin tạo HS trỏ vào PH bí mật; người dùng A không thấy PH đó nên nhãn ẩn đi
    const hs2 = (await st(rec(admin.token, 'hoc_sinh', { ten: 'HS giao A', phu_huynh: pOfAdmin.id }, u.id), 201)).body as Body
    const seen = (await st(a(u.token).get(`${BASE}/hoc_sinh/records/${hs2.id}`), 200)).body as Body
    expect(seen.relations.phu_huynh).toEqual({ id: pOfAdmin.id, title: null, accessible: false })
    expect(JSON.stringify(seen)).not.toContain('PH bí mật')
    // combobox: chỉ trong phạm vi, chỉ id + title
    const lk = (await st(a(u.token).get(`${BASE}/phu_huynh/lookup`), 200)).body
    expect(lk).toEqual([{ id: pOfA.id, title: 'PH của A', code: expect.stringMatching(/^[A-Z]+\d+$/) }])
    expect((await st(a(admin.token).get(`${BASE}/phu_huynh/lookup`, { q: 'bí mật' }), 200)).body).toHaveLength(1)
    // liên quan ngược: Phụ huynh → Học sinh (chỉ phần A xem được)
    const rel = (await st(a(u.token).get(`${BASE}/phu_huynh/records/${pOfA.id}/related`), 200)).body
    expect(rel).toEqual([expect.objectContaining({ object: expect.objectContaining({ key: 'hoc_sinh' }), total: 1, items: [{ id: hs.id, title: 'HS của A', code: expect.any(String) }] })])
    // định nghĩa kèm khoá thực thể đích (để FE dựng liên kết), chỉ khi người xem thấy được thực thể đích
    const defA = (await st(a(u.token).get(`${BASE}/hoc_sinh`), 200)).body as Body
    expect(defA.fields.find((x: { key: string }) => x.key === 'phu_huynh').options).toMatchObject({ target_object_id: phObj.id, target_key: 'phu_huynh' })
    const roleOfA = await roleOf(u.id)
    const outsider = await mk({ 'custom_records.view': 'all' })
    await st(a(admin.token).patch(`${BASE}/phu_huynh`, { visible_role_ids: [roleOfA] }), 200)
    const defOutsider = (await st(a(outsider.token).get(`${BASE}/hoc_sinh`), 200)).body as Body
    expect(defOutsider.fields.find((x: { key: string }) => x.key === 'phu_huynh').options.target_key).toBeUndefined()
    await st(a(admin.token).patch(`${BASE}/phu_huynh`, { visible_role_ids: [] }), 200)
    // xoá thực thể đích khi còn liên kết → 409
    await st(a(admin.token).del(`${BASE}/phu_huynh`), 409)
    // lọc theo liên kết
    const f = (await st(a(admin.token).get(`${BASE}/hoc_sinh/records`, { filter: JSON.stringify({ phu_huynh: pOfA.id }) }), 200)).body as Body
    expect(f.items.map((x: { id: number }) => x.id)).toEqual([hs.id])
  })

  it('danh sách: cursor phân trang, sắp xếp (số/chữ/NULL cuối), lọc select/khoảng số/ngày, tìm theo tiêu đề (ký tự % _ đúng nghĩa đen)', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t)
    await mkField(t, 'hoc_sinh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(t, 'hoc_sinh', { label: 'Điểm', key: 'diem', type: 'number' })
    await mkField(t, 'hoc_sinh', { label: 'TT', key: 'tt', type: 'select', options: { choices: [{ label: 'Học', value: 'hoc' }, { label: 'Nghỉ', value: 'nghi' }] } })
    await mkField(t, 'hoc_sinh', { label: 'Ngày', key: 'ngay', type: 'date' })
    await mkField(t, 'hoc_sinh', { label: 'Tag', key: 'tag', type: 'multi_select', options: { choices: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] } })
    const rows = [
      { ten: 'An', diem: 9, tt: 'hoc', ngay: '2025-01-10', tag: ['a'] },
      { ten: 'Bình', diem: 7.5, tt: 'nghi', ngay: '2025-02-10', tag: ['b'] },
      { ten: 'Chi', tt: 'hoc', ngay: '2025-03-10', tag: ['a', 'b'] },
      { ten: '100% đúng', diem: 5, tt: 'hoc' },
      { ten: 'a_b', diem: 1 },
    ]
    for (const r of rows) await st(rec(t, 'hoc_sinh', r), 201)
    const get = async (query: Record<string, string>): Promise<Body> => (await st(a(t).get(`${BASE}/hoc_sinh/records`, query), 200)).body
    const names = (b: { items: { data: { ten: string } }[] }): string[] => b.items.map((x) => x.data.ten)
    const walk = async (base: Record<string, string>): Promise<string[]> => {
      const out: string[] = []
      let cursor: string | undefined
      for (let i = 0; i < 6; i++) {
        const page = await get({ ...base, limit: '2', ...(cursor ? { cursor } : {}) })
        out.push(...names(page))
        cursor = page.next_cursor ?? undefined
        if (!cursor) break
      }
      return out
    }
    // mặc định: mới nhất trước, cursor đi hết không trùng không sót
    expect(await walk({})).toEqual(['a_b', '100% đúng', 'Chi', 'Bình', 'An'])
    expect((await get({ limit: '2' })).total).toBe(5)
    // sắp xếp theo số, NULL luôn cuối (cả 2 chiều), phân trang bằng cursor khoá kép
    expect(names(await get({ sort: 'field:diem', dir: 'desc' }))).toEqual(['An', 'Bình', '100% đúng', 'a_b', 'Chi'])
    expect(names(await get({ sort: 'field:diem', dir: 'asc' }))).toEqual(['a_b', '100% đúng', 'Bình', 'An', 'Chi'])
    expect(await walk({ sort: 'field:diem', dir: 'asc' })).toEqual(['a_b', '100% đúng', 'Bình', 'An', 'Chi'])
    expect(names(await get({ sort: 'title', dir: 'asc' }))[0]).toBe('100% đúng')
    // sắp xếp theo updated_at (kiểu timestamptz) cũng đi hết bằng cursor, không trùng không sót
    const u = await walk({ sort: 'updated_at', dir: 'asc' })
    expect(u).toHaveLength(5)
    expect(new Set(u).size).toBe(5)
    // lọc
    expect(names(await get({ filter: JSON.stringify({ tt: 'nghi' }) }))).toEqual(['Bình'])
    expect(names(await get({ filter: JSON.stringify({ tt: ['nghi', 'hoc'] }), sort: 'field:diem', dir: 'asc' }))).toEqual(['100% đúng', 'Bình', 'An', 'Chi'])
    expect(names(await get({ filter: JSON.stringify({ diem: { min: 5, max: 8 } }), sort: 'field:diem', dir: 'asc' }))).toEqual(['100% đúng', 'Bình'])
    expect(names(await get({ filter: JSON.stringify({ ngay: { from: '2025-02-01', to: '2025-03-31' } }), sort: 'field:ngay', dir: 'asc' }))).toEqual(['Bình', 'Chi'])
    expect(names(await get({ filter: JSON.stringify({ tag: ['b'] }), sort: 'field:ten', dir: 'asc' }))).toEqual(['Bình', 'Chi'])
    // tìm theo tiêu đề: % và _ là ký tự thường
    expect(names(await get({ q: '100%' }))).toEqual(['100% đúng'])
    expect(names(await get({ q: 'a_b' }))).toEqual(['a_b'])
    expect((await get({ q: '%' })).total).toBe(1)
    // injection / đầu vào xấu
    for (const bad of [
      { sort: "field:diem'; DROP TABLE custom_records;--" }, { sort: 'field:khong_co' }, { sort: 'id; select 1' },
      { filter: '{"diem": ' }, { filter: '[]' }, { filter: JSON.stringify({ "x') OR 1=1 --": 1 }) }, { filter: JSON.stringify({ diem: { min: "1' OR '1'='1" } }) },
      { cursor: 'rác' }, { sort: 'field:diem', cursor: Buffer.from('{"id":1,"v":"abc"}').toString('base64url') }, { cursor: Buffer.from('{"id":"1 OR 1=1","v":null}').toString('base64url') },
      { limit: '1000' }, { dir: 'sideways' },
    ] as Record<string, string>[]) await st(a(t).get(`${BASE}/hoc_sinh/records`, bad), 400)
    expect(await count('custom_records')).toBe(5)
  })

  it('xuất CSV: cần *.export, BOM UTF-8, nhãn thay mã, chống CSV-injection, cắt có báo rõ', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t)
    await mkField(t, 'hoc_sinh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(t, 'hoc_sinh', { label: 'TT', key: 'tt', type: 'select', options: { choices: [{ label: 'Đang học', value: 'hoc' }] } })
    await mkField(t, 'hoc_sinh', { label: 'Ngày', key: 'ngay', type: 'date' })
    await st(rec(t, 'hoc_sinh', { ten: '=HYPERLINK("http://evil")', tt: 'hoc', ngay: '2025-02-10' }), 201)
    await st(rec(t, 'hoc_sinh', { ten: 'Có, dấu "phẩy"' }), 201)
    const noExport = await mk({ 'custom_records.view': 'all' })
    await st(a(noExport.token).get(`${BASE}/hoc_sinh/records/export`), 403)
    const res = await st(a(t).get(`${BASE}/hoc_sinh/records/export`), 200)
    const text = String(res.body)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('x-truncated')).toBe('false')
    expect(res.headers.get('x-exported-rows')).toBe('2')
    expect([...(await getBytes(`${BASE}/hoc_sinh/records/export`, t)).slice(0, 3)], 'BOM UTF-8').toEqual([0xef, 0xbb, 0xbf])
    expect(text).toContain("'=HYPERLINK")
    expect(text).toContain('Đang học')
    expect(text).toContain('10/02/2025')
    expect(text).toContain('"Có, dấu ""phẩy"""')
    // phạm vi xuất = GIAO của xem và xuất: export all nhưng view own → chỉ phần của mình
    const mine = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'own', 'custom_records.export': 'all' })
    await st(rec(mine.token, 'hoc_sinh', { ten: 'của tôi' }), 201)
    const own = await st(a(mine.token).get(`${BASE}/hoc_sinh/records/export`), 200)
    expect(own.headers.get('x-exported-rows')).toBe('1')
    expect(String(own.body)).not.toContain('HYPERLINK')
  })

  it('outbox: tạo/sửa/xoá bản ghi ghi sự kiện custom_record.* cùng transaction (SĐT thô, che ở bước gửi)', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t, 'phu_huynh')
    await mkField(t, 'phu_huynh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(t, 'phu_huynh', { label: 'SĐT', key: 'sdt', type: 'phone' })
    await mkField(t, 'phu_huynh', { label: 'Tính', key: 'tinh', type: 'formula', options: { expression: '1+1' } })
    const r = (await st(rec(t, 'phu_huynh', { ten: 'A', sdt: '0900000123' }), 201)).body as Body
    await st(a(t).patch(`${BASE}/phu_huynh/records/${r.id}`, { data: { ten: 'B' } }), 200)
    await st(a(t).del(`${BASE}/phu_huynh/records/${r.id}`), 200)
    // lỗi validate KHÔNG ghi sự kiện
    await st(rec(t, 'phu_huynh', { sdt: 'xx' }), 400)
    const ev = await q<{ event_type: string; resource: string; resource_id: string; payload: Body }>(`SELECT event_type, resource, resource_id, payload FROM integration_events ORDER BY id`)
    expect(ev.map((e) => e.event_type)).toEqual(['custom_record.created', 'custom_record.updated', 'custom_record.deleted'])
    expect(ev.every((e) => e.resource === 'custom_record' && e.resource_id === String(r.id))).toBe(true)
    const created = ev[0].payload
    expect(created.object.key).toBe('phu_huynh')
    expect(created.record.phone_fields).toEqual(['sdt'])
    expect(created.record.data).toEqual({ ten: 'A', sdt: '0900000123' }) // không có trường công thức
    expect(ev[1].payload.changed_fields).toEqual(['ten'])
  })

  it('giới hạn: số thực thể, số trường, kích thước dữ liệu', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t)
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú', key: 'gc', type: 'long_text' })
    const big = 'x'.repeat(9_000)
    const r = await st(rec(t, 'hoc_sinh', { gc: big }), 201)
    expect((r.body as Body).id).toBeGreaterThan(0)
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú 2', key: 'gc2', type: 'long_text' })
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú 3', key: 'gc3', type: 'long_text' })
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú 4', key: 'gc4', type: 'long_text' })
    const e = await st(rec(t, 'hoc_sinh', { gc: big, gc2: big, gc3: big, gc4: big }), 400)
    expect((e.body as Body).errors._data).toBeDefined()
    await st(a(t).post(`${BASE}/hoc_sinh/records`, { data: { gc: 'x'.repeat(10_001) } }), 400)
    let blockedAt = -1
    for (let i = 0; i < 60; i++) {
      const res = await a(t).post(`${BASE}/hoc_sinh/fields`, { label: `T${i}`, key: `t${i}`, type: 'text' })
      if (res.status === 400) {
        blockedAt = i
        break
      }
    }
    expect(blockedAt, 'phải chặn trước 60 trường').toBeGreaterThanOrEqual(55)
  })

  it('các ca biên: SĐT không được đặt duy nhất, khoá trường trùng Object.prototype, nhãn rỗng, manage ⊄ view, user ngoài phạm vi, owner_id null, lost update, NUL/ngày sai', async () => {
    const admin: U = await mk(ALL)
    const t = admin.token
    await mkObject(t)
    await mkField(t, 'hoc_sinh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú', key: 'gc', type: 'long_text' })
    await mkField(t, 'hoc_sinh', { label: 'Người lo', key: 'nguoi', type: 'user' })
    // phone không được đặt duy nhất (oracle dò SĐT vòng qua phone_full)
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'SĐT', key: 'sdt', type: 'phone', is_unique: true }), 400)
    // khoá trùng thuộc tính Object.prototype
    for (const k of ['constructor', 'valueof', 'tostring', 'hasownproperty']) {
      const r = await a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'X', key: k, type: 'text' })
      expect([201, 400]).toContain(r.status) // chữ thường không trùng; chỉ khoá TRÙNG THẬT bị chặn
    }
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: 'X', key: 'constructor', type: 'text' }), 400)
    // nhãn toàn khoảng trắng
    await st(a(t).post(BASE, { key: 'trang', label: '   ', label_plural: 'x' }), 400)
    await st(a(t).post(`${BASE}/hoc_sinh/fields`, { label: '   ', type: 'text' }), 400)
    // thiếu view → không ghi được; manage rộng hơn view → phản hồi tối giản, không rò dữ liệu
    const manageOnly = await mk({ 'custom_records.manage': 'all' })
    await st(rec(manageOnly.token, 'hoc_sinh', { ten: 'x' }), 403)
    const wide = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'all' })
    const other = (await st(rec(t, 'hoc_sinh', { ten: 'bí mật', gc: 'nội dung riêng' }), 201)).body as Body
    const patched = await st(a(wide.token).patch(`${BASE}/hoc_sinh/records/${other.id}`, { data: { ten: 'sửa' } }), 200)
    expect(patched.body).toEqual({ id: other.id })
    await st(a(wide.token).get(`${BASE}/hoc_sinh/records/${other.id}`), 404)
    // trường user chỉ chọn người TRONG phạm vi; ngoài phạm vi → 400
    const boss = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'own' })
    const stranger = await mk({})
    const bad = await st(rec(boss.token, 'hoc_sinh', { ten: 'a', nguoi: stranger.id }), 400)
    expect((bad.body as Body).errors.nguoi).toBeDefined()
    const okSelf = await st(rec(boss.token, 'hoc_sinh', { ten: 'b', nguoi: boss.id }), 201)
    expect((okSelf.body as Body).relations.nguoi.accessible).toBe(true)
    // owner_id null = mặc định (không 500)
    const nul = await st(a(t).post(`${BASE}/hoc_sinh/records`, { data: { ten: 'c' }, owner_id: null }), 201)
    expect((nul.body as Body).owner_id).toBe(admin.id)
    // 2 PATCH song song khác trường không ghi đè nhau
    const base = (await st(rec(t, 'hoc_sinh', { ten: 'goc' }), 201)).body as Body
    const [p1, p2] = await Promise.all([
      a(t).patch(`${BASE}/hoc_sinh/records/${base.id}`, { data: { ten: 'moi' } }),
      a(t).patch(`${BASE}/hoc_sinh/records/${base.id}`, { data: { gc: 'ghi chú mới' } }),
    ])
    expect([p1.status, p2.status]).toEqual([200, 200])
    const after = (await st(a(t).get(`${BASE}/hoc_sinh/records/${base.id}`), 200)).body as Body
    expect(after.data).toMatchObject({ ten: 'moi', gc: 'ghi chú mới' })
    // con trỏ ngày sai, NUL trong q/filter
    const upd = Buffer.from(JSON.stringify({ v: '2026-02-30 10:00:00+00', id: 1 })).toString('base64url')
    await st(a(t).get(`${BASE}/hoc_sinh/records`, { sort: 'updated_at', cursor: upd }), 400)
    await st(a(t).get(`${BASE}/hoc_sinh/records?q=a%00b`), 400)
    await st(a(t).get(`${BASE}/hoc_sinh/records`, { filter: '{"nguoi":[1],"x":"\\u0000"}' }), 400)
    // long_text → text khi có giá trị > 500 ký tự
    await mkField(t, 'hoc_sinh', { label: 'Dài', key: 'dai', type: 'long_text' })
    await st(rec(t, 'hoc_sinh', { ten: 'long', dai: 'x'.repeat(600) }), 201)
    await st(a(t).patch(`${BASE}/hoc_sinh/fields/dai`, { type: 'text' }), 409)
  })
})
