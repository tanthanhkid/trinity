import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * Thực thể tuỳ biến: ma trận quyền + phạm vi, validate theo định nghĩa trường, công thức, liên kết,
 * lọc/sắp xếp/cursor, che SĐT (quyền riêng `custom_records.phone_full`), xuất CSV, outbox sự kiện.
 */
const ALL = { 'custom_objects.manage': true, 'custom_records.view': 'all', 'custom_records.manage': 'all', 'custom_records.delete': 'all', 'custom_records.export': 'all', 'custom_records.phone_full': 'all' } as const
const BASE = '/api/v1/custom-objects'

describe('RBAC E2E — Thực thể tuỳ biến', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp({ validation: true }))
  }, 60_000)
  afterAll(async () => close())
  afterEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE custom_records, custom_fields, custom_objects, integration_events RESTART IDENTITY CASCADE`)
    await resetDb(prisma)
  })

  const mk = (grants: Record<string, unknown>, extra: { managerId?: number } = {}) => makeUser(prisma, { grants: grants as never, ...extra })

  async function mkObject(token: string, key = 'hoc_sinh', body: Record<string, unknown> = {}) {
    return (await api(app, token).post(BASE).send({ key, label: 'Học sinh', label_plural: 'Học sinh', ...body }).expect(201)).body
  }
  async function mkField(token: string, key: string, body: Record<string, unknown>) {
    const r = await api(app, token).post(`${BASE}/${key}/fields`).send(body); expect({ status: r.status, body: r.body }).toMatchObject({ status: 201 }); return r.body
  }
  const rec = (token: string, key: string, data: Record<string, unknown>, owner?: number) =>
    api(app, token).post(`${BASE}/${key}/records`).send(owner ? { data, owner_id: owner } : { data })

  it('401 không token; 403 khi thiếu quyền ở MỌI route', async () => {
    await api(app).get(`${BASE}/nav`).expect(401)
    const none = await mk({})
    const t = none.token
    await api(app, t).get(BASE).expect(403)
    await api(app, t).post(BASE).send({ key: 'a', label: 'A', label_plural: 'A' }).expect(403)
    await api(app, t).get(`${BASE}/nav`).expect(403)
    await api(app, t).get(`${BASE}/x`).expect(403)
    await api(app, t).patch(`${BASE}/x`).send({}).expect(403)
    await api(app, t).delete(`${BASE}/x`).expect(403)
    await api(app, t).post(`${BASE}/x/fields`).send({ label: 'A', type: 'text' }).expect(403)
    await api(app, t).get(`${BASE}/x/records`).expect(403)
    await api(app, t).post(`${BASE}/x/records`).send({ data: {} }).expect(403)
    await api(app, t).get(`${BASE}/x/records/1`).expect(403)
    await api(app, t).patch(`${BASE}/x/records/1`).send({ data: {} }).expect(403)
    await api(app, t).delete(`${BASE}/x/records/1`).expect(403)
    await api(app, t).get(`${BASE}/x/records/export`).expect(403)
    await api(app, t).get(`${BASE}/x/lookup`).expect(403)
    await api(app, t).get(`${BASE}/lookup/users`).expect(403)
    await api(app, t).post(`${BASE}/formula/preview`).send({ object_key: 'x', expression: '1' }).expect(403)
    // chỉ view: không cấu hình được
    const viewer = await mk({ 'custom_records.view': 'all' })
    await api(app, viewer.token).post(BASE).send({ key: 'a', label: 'A', label_plural: 'A' }).expect(403)
    await api(app, viewer.token).get(`${BASE}/nav`).expect(200)
  })

  it('tạo thực thể: kiểm key / icon / vai trò / trùng; mặc định; sửa; nav', async () => {
    const admin = await mk(ALL)
    const t = admin.token
    await api(app, t).post(BASE).send({ key: 'Hoc Sinh', label: 'A', label_plural: 'A' }).expect(400)
    await api(app, t).post(BASE).send({ key: 'nav', label: 'A', label_plural: 'A' }).expect(400)
    await api(app, t).post(BASE).send({ key: 'ok', label: 'A', label_plural: 'A', icon: 'rocket-evil' }).expect(400)
    await api(app, t).post(BASE).send({ key: 'ok', label: 'A', label_plural: 'A', visible_role_ids: [999999] }).expect(400)
    await api(app, t).post(BASE).send({ key: 'ok', label: 'A', label_plural: 'A', hack: 1 }).expect(400)
    const o = await mkObject(t, 'hoc_sinh', { icon: 'graduation-cap' })
    expect(o).toMatchObject({ key: 'hoc_sinh', show_in_nav: true, is_active: true, visible_role_ids: [] })
    await api(app, t).post(BASE).send({ key: 'hoc_sinh', label: 'B', label_plural: 'B' }).expect(409)
    await api(app, t).patch(`${BASE}/hoc_sinh`).send({ label: 'Học viên', key: 'khac' }).expect(400)
    const u = await api(app, t).patch(`${BASE}/hoc_sinh`).send({ label: 'Học viên' }).expect(200)
    expect(u.body.label).toBe('Học viên')
    const nav = await api(app, t).get(`${BASE}/nav`).expect(200)
    expect(nav.body).toEqual([expect.objectContaining({ key: 'hoc_sinh', label: 'Học viên', icon: 'graduation-cap' })])
    await api(app, t).patch(`${BASE}/hoc_sinh`).send({ show_in_nav: false }).expect(200)
    expect((await api(app, t).get(`${BASE}/nav`).expect(200)).body).toEqual([])
  })

  it('visible_role_ids chỉ THU HẸP: người ngoài vai trò → 404 + không có trong menu; người giữ manage vẫn thấy; không cấp thêm quyền', async () => {
    const admin = await mk(ALL)
    const inRole = await mk({ 'custom_records.view': 'all' })
    const outRole = await mk({ 'custom_records.view': 'all' })
    const roleId = (await prisma.userRole.findFirstOrThrow({ where: { user_id: inRole.id } })).role_id
    await mkObject(admin.token, 'bi_mat', { visible_role_ids: [roleId] })
    expect((await api(app, inRole.token).get(`${BASE}/nav`).expect(200)).body).toHaveLength(1)
    await api(app, inRole.token).get(`${BASE}/bi_mat`).expect(200)
    expect((await api(app, outRole.token).get(`${BASE}/nav`).expect(200)).body).toHaveLength(0)
    await api(app, outRole.token).get(`${BASE}/bi_mat`).expect(404)
    await api(app, outRole.token).get(`${BASE}/bi_mat/records`).expect(404)
    expect((await api(app, admin.token).get(`${BASE}/bi_mat`).expect(200)).body.key).toBe('bi_mat')
    // vai trò có trong danh sách nhưng KHÔNG có quyền xem dữ liệu → vẫn 403 (không cấp thêm quyền)
    const noPerm = await mk({})
    const noPermRole = (await prisma.userRole.findFirstOrThrow({ where: { user_id: noPerm.id } })).role_id
    await api(app, admin.token).patch(`${BASE}/bi_mat`).send({ visible_role_ids: [noPermRole] }).expect(200)
    await api(app, noPerm.token).get(`${BASE}/bi_mat/records`).expect(403)
    // tắt thực thể: người thường 404, quản trị vẫn thấy
    await api(app, admin.token).patch(`${BASE}/bi_mat`).send({ visible_role_ids: [], is_active: false }).expect(200)
    await api(app, inRole.token).get(`${BASE}/bi_mat/records`).expect(404)
    await api(app, admin.token).get(`${BASE}/bi_mat/records`).expect(200)
  })

  it('trường: kiểm kiểu, select cần lựa chọn, tiêu đề tự gán, khoá bất biến, công thức sai bị từ chối', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t)
    const f1 = await mkField(t, 'hoc_sinh', { label: 'Họ và tên', type: 'text', required: true })
    expect(f1).toMatchObject({ key: 'ho_va_ten', is_title: true, required: true })
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'Họ và tên', type: 'text' }).expect(409)
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'X', type: 'khong_co' }).expect(400)
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'Giới tính', type: 'select' }).expect(400)
    const sel = await mkField(t, 'hoc_sinh', { label: 'Giới tính', type: 'select', options: { choices: [{ label: 'Nam' }, { label: 'Nữ' }] } })
    expect(sel.options.choices.map((c: { value: string }) => c.value)).toEqual(['nam', 'nu'])
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'Cv', type: 'formula', options: { expression: 'process.exit(1)' } }).expect(400)
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'Cv', type: 'formula', options: { expression: '{khong_co}*2' } }).expect(400)
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'Cv', type: 'text', is_unique: true, required: true }).expect(201)
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'Mô tả', type: 'long_text', is_unique: true }).expect(400)
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'Mã', type: 'phone', is_title: true }).expect(400)
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'Rel', type: 'relation', options: { target_object_id: 9999 } }).expect(400)
    await api(app, t).patch(`${BASE}/hoc_sinh/fields/ho_va_ten`).send({ key: 'doi_khoa' }).expect(400)
    await api(app, t).delete(`${BASE}/hoc_sinh/fields/ho_va_ten`).expect(409) // đang là tiêu đề
    const detail = (await api(app, t).get(`${BASE}/hoc_sinh`).expect(200)).body
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

    const bad = async (data: Record<string, unknown>, key: string) => {
      const r = await rec(t, 'hoc_sinh', { ten: 'A', ...data }).expect(400)
      expect(Object.keys(r.body.errors)).toContain(key)
    }
    await rec(t, 'hoc_sinh', {}).expect(400)
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
    const sneaky = await api(app, t).post(`${BASE}/hoc_sinh/records`).set('Content-Type', 'application/json').send('{"data":{"ten":"S","constructor":2,"__proto__":{"x":1}}}').expect(201)
    expect(Object.keys(sneaky.body.data).sort()).toEqual(['ten', 'tinh'])
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    await bad({ da: 'maybe' }, 'da')

    const ok = await rec(t, 'hoc_sinh', { ten: ' Học sinh Mẫu 01 ', ma: 'HS01', gt: 'nam', st: ['ve'], sdt: '+84 912 345 678', em: 'A@X.VN', web: 'https://x.vn', sinh: '2015-05-20', phi: 9_600_000, giam: 5, da: true }).expect(201)
    expect(ok.body.title).toBe('Học sinh Mẫu 01')
    expect(ok.body.data).toMatchObject({ sdt: '0912345678', em: 'a@x.vn', tinh: 9_120_000 })
    // duy nhất (không phân biệt hoa-thường), cả khi sửa sang giá trị của bản khác
    const dup = await rec(t, 'hoc_sinh', { ten: 'B', ma: 'hs01' }).expect(400)
    expect(dup.body.errors.ma).toMatch(/đã tồn tại/)
    const b = await rec(t, 'hoc_sinh', { ten: 'B', ma: 'HS02' }).expect(201)
    await api(app, t).patch(`${BASE}/hoc_sinh/records/${b.body.id}`).send({ data: { ma: 'HS01' } }).expect(400)
    // sửa một phần giữ nguyên phần còn lại; null xoá giá trị; xoá trường bắt buộc → 400
    const p = await api(app, t).patch(`${BASE}/hoc_sinh/records/${ok.body.id}`).send({ data: { phi: 1_000_000, gt: null } }).expect(200)
    expect(p.body.data).toMatchObject({ ten: 'Học sinh Mẫu 01', phi: 1_000_000, tinh: 950_000 })
    expect(p.body.data.gt).toBeUndefined()
    await api(app, t).patch(`${BASE}/hoc_sinh/records/${ok.body.id}`).send({ data: { ten: null } }).expect(400)
    // đổi kiểu trường có dữ liệu / bỏ lựa chọn đang dùng → 409
    await api(app, t).patch(`${BASE}/hoc_sinh/fields/phi`).send({ type: 'date' }).expect(409)
    await api(app, t).patch(`${BASE}/hoc_sinh/fields/st`).send({ options: { choices: [{ label: 'Đá bóng', value: 'bong' }] } }).expect(409)
    await api(app, t).patch(`${BASE}/hoc_sinh/fields/phi`).send({ type: 'number' }).expect(409)
    await api(app, t).delete(`${BASE}/hoc_sinh/fields/phi`).expect(409) // công thức `tinh` đang dùng
    await api(app, t).delete(`${BASE}/hoc_sinh/fields/tinh`).expect(200)
    await api(app, t).delete(`${BASE}/hoc_sinh/fields/phi`).expect(200)
    // khoá cũ còn dữ liệu → không tạo lại trùng khoá
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ key: 'phi', label: 'Phí mới', type: 'text' }).expect(409)
  })

  it('công thức: tính theo ngày/tiền, xem trước, thiếu dữ liệu → null', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t, 'ghi_danh')
    await mkField(t, 'ghi_danh', { label: 'Mã', key: 'ma', type: 'text' })
    await mkField(t, 'ghi_danh', { label: 'Bắt đầu', key: 'bat_dau', type: 'date' })
    await mkField(t, 'ghi_danh', { label: 'Kết thúc', key: 'ket_thuc', type: 'date' })
    await mkField(t, 'ghi_danh', { label: 'Thực tế (tháng)', key: 'thuc_te', type: 'formula', options: { expression: 'round(months_between({bat_dau}, {ket_thuc}), 1)' } })
    const pv = await api(app, t).post(`${BASE}/formula/preview`).send({ object_key: 'ghi_danh', expression: 'months_between({bat_dau},{ket_thuc})', sample: { bat_dau: '2025-01-01', ket_thuc: '2025-04-01' } }).expect(201)
    expect(pv.body).toEqual({ ok: true, result: 3 })
    const bad = await api(app, t).post(`${BASE}/formula/preview`).send({ object_key: 'ghi_danh', expression: '{ma}+1' }).expect(201)
    expect(bad.body.ok).toBe(false)
    const r = await rec(t, 'ghi_danh', { ma: 'GD1', bat_dau: '2025-01-01', ket_thuc: '2025-02-16' }).expect(201)
    expect(r.body.data.thuc_te).toBe(1.5)
    const r2 = await rec(t, 'ghi_danh', { ma: 'GD2', bat_dau: '2025-01-01' }).expect(201)
    expect(r2.body.data.thuc_te).toBeNull()
  })

  it('phạm vi: scope own chỉ thấy/sửa/xoá bản ghi của mình (owner ∪ người tạo), ngoài phạm vi theo id → 404; giao người phụ trách phải trong phạm vi', async () => {
    const admin = await mk(ALL)
    const boss = await mk({ 'custom_records.view': 'subtree', 'custom_records.manage': 'subtree', 'custom_records.delete': 'subtree' })
    const a = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'own', 'custom_records.delete': 'own' }, { managerId: boss.id })
    const b = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'own', 'custom_records.delete': 'own' }, { managerId: boss.id })
    await mkObject(admin.token)
    await mkField(admin.token, 'hoc_sinh', { label: 'Tên', key: 'ten', type: 'text' })
    const ra = (await rec(a.token, 'hoc_sinh', { ten: 'của A' }).expect(201)).body
    const rb = (await rec(b.token, 'hoc_sinh', { ten: 'của B' }).expect(201)).body
    expect(ra.owner_id).toBe(a.id)
    const la = (await api(app, a.token).get(`${BASE}/hoc_sinh/records`).expect(200)).body
    expect(la.items.map((x: { id: number }) => x.id)).toEqual([ra.id])
    expect(la.total).toBe(1)
    expect((await api(app, boss.token).get(`${BASE}/hoc_sinh/records`).expect(200)).body.total).toBe(2)
    expect((await api(app, admin.token).get(`${BASE}/hoc_sinh/records`).expect(200)).body.total).toBe(2)
    await api(app, a.token).get(`${BASE}/hoc_sinh/records/${rb.id}`).expect(404)
    await api(app, a.token).patch(`${BASE}/hoc_sinh/records/${rb.id}`).send({ data: { ten: 'hack' } }).expect(404)
    await api(app, a.token).delete(`${BASE}/hoc_sinh/records/${rb.id}`).expect(404)
    await api(app, a.token).get(`${BASE}/hoc_sinh/records/${rb.id}/related`).expect(404)
    // giao cho người ngoài phạm vi → 400; cấp trên giao xuống cấp dưới được
    await rec(a.token, 'hoc_sinh', { ten: 'x' }, b.id).expect(400)
    const giao = await rec(boss.token, 'hoc_sinh', { ten: 'boss giao' }, a.id).expect(201)
    await api(app, a.token).get(`${BASE}/hoc_sinh/records/${giao.body.id}`).expect(200) // owner = a
    // chỉ view: không ghi
    const viewer = await mk({ 'custom_records.view': 'all' })
    await rec(viewer.token, 'hoc_sinh', { ten: 'x' }).expect(403)
    await api(app, viewer.token).delete(`${BASE}/hoc_sinh/records/${ra.id}`).expect(403)
    await api(app, a.token).delete(`${BASE}/hoc_sinh/records/${ra.id}`).expect(200)
    await api(app, a.token).get(`${BASE}/hoc_sinh/records/${ra.id}`).expect(404)
  })

  it('SĐT: che theo custom_records.phone_full RIÊNG (contacts.phone_full không mở), mọi đường ra (list/detail/export/lookup)', async () => {
    const admin = await mk(ALL)
    await mkObject(admin.token, 'phu_huynh')
    await mkField(admin.token, 'phu_huynh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(admin.token, 'phu_huynh', { label: 'SĐT', key: 'sdt', type: 'phone' })
    const r = (await rec(admin.token, 'phu_huynh', { ten: 'PH Mẫu', sdt: '0900000123' }).expect(201)).body
    expect(r.data.sdt).toBe('0900000123')
    const other = await mk({ 'custom_records.view': 'all', 'custom_records.export': 'all', 'contacts.phone_full': 'all' })
    const masked = (await api(app, other.token).get(`${BASE}/phu_huynh/records/${r.id}`).expect(200)).body
    expect(masked.data.sdt).toBe('***123')
    expect((await api(app, other.token).get(`${BASE}/phu_huynh/records`).expect(200)).body.items[0].data.sdt).toBe('***123')
    const csv = (await api(app, other.token).get(`${BASE}/phu_huynh/records/export`).expect(200)).text
    expect(csv).toContain('***123')
    expect(csv).not.toContain('0900000123')
    const full = await mk({ 'custom_records.view': 'all', 'custom_records.phone_full': 'all' })
    expect((await api(app, full.token).get(`${BASE}/phu_huynh/records/${r.id}`).expect(200)).body.data.sdt).toBe('0900000123')
    // không lọc / sắp xếp theo SĐT (chống dò từng chữ số)
    await api(app, other.token).get(`${BASE}/phu_huynh/records`).query({ filter: JSON.stringify({ sdt: '0900' }) }).expect(400)
    await api(app, other.token).get(`${BASE}/phu_huynh/records`).query({ sort: 'field:sdt' }).expect(400)
  })

  it('liên kết: chỉ chọn/đọc bản ghi TRONG phạm vi; tiêu đề ngoài phạm vi không lộ; tra cứu chỉ {id,title}; bản ghi liên quan ngược', async () => {
    const admin = await mk(ALL)
    const a = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'own' })
    await mkObject(admin.token, 'phu_huynh')
    await mkField(admin.token, 'phu_huynh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(admin.token, 'phu_huynh', { label: 'SĐT', key: 'sdt', type: 'phone' })
    await mkObject(admin.token, 'hoc_sinh')
    await mkField(admin.token, 'hoc_sinh', { label: 'Tên', key: 'ten', type: 'text' })
    const ph = (await mkObject(admin.token, 'ban_nhap')).id
    expect(ph).toBeGreaterThan(0)
    const phObj = (await api(app, admin.token).get(`${BASE}/phu_huynh`).expect(200)).body
    await mkField(admin.token, 'hoc_sinh', { label: 'Phụ huynh', key: 'phu_huynh', type: 'relation', options: { target_object_id: phObj.id } })
    await mkField(admin.token, 'hoc_sinh', { label: 'Người lo', key: 'nguoi', type: 'user' })
    const pOfA = (await rec(a.token, 'phu_huynh', { ten: 'PH của A', sdt: '0900000111' }).expect(201)).body
    const pOfAdmin = (await rec(admin.token, 'phu_huynh', { ten: 'PH bí mật', sdt: '0900000222' }).expect(201)).body
    // A không chọn được bản ghi ngoài phạm vi; id không tồn tại cũng vậy
    const e1 = await rec(a.token, 'hoc_sinh', { ten: 'HS', phu_huynh: pOfAdmin.id }).expect(400)
    expect(e1.body.errors.phu_huynh).toBeDefined()
    await rec(a.token, 'hoc_sinh', { ten: 'HS', phu_huynh: 999999 }).expect(400)
    await rec(a.token, 'hoc_sinh', { ten: 'HS', nguoi: 999999 }).expect(400)
    const hs = (await rec(a.token, 'hoc_sinh', { ten: 'HS của A', phu_huynh: pOfA.id, nguoi: a.id }).expect(201)).body
    expect(hs.relations.phu_huynh).toEqual({ id: pOfA.id, title: 'PH của A', accessible: true })
    expect(hs.relations.nguoi.accessible).toBe(true)
    // Admin tạo HS trỏ vào PH bí mật; người dùng A (có HS của chính mình) không thấy HS đó, nhưng nếu được giao thì nhãn PH ẩn đi
    const hs2 = (await rec(admin.token, 'hoc_sinh', { ten: 'HS giao A', phu_huynh: pOfAdmin.id }, a.id).expect(201)).body
    const seen = (await api(app, a.token).get(`${BASE}/hoc_sinh/records/${hs2.id}`).expect(200)).body
    expect(seen.relations.phu_huynh).toEqual({ id: pOfAdmin.id, title: null, accessible: false })
    expect(JSON.stringify(seen)).not.toContain('PH bí mật')
    // combobox: chỉ trong phạm vi, chỉ id + title
    const lk = (await api(app, a.token).get(`${BASE}/phu_huynh/lookup`).expect(200)).body
    expect(lk).toEqual([{ id: pOfA.id, title: 'PH của A', code: expect.stringMatching(/^[A-Z]+\d+$/) }])
    expect((await api(app, admin.token).get(`${BASE}/phu_huynh/lookup`).query({ q: 'bí mật' }).expect(200)).body).toHaveLength(1)
    // liên quan ngược: Phụ huynh → Học sinh (chỉ phần A xem được)
    const rel = (await api(app, a.token).get(`${BASE}/phu_huynh/records/${pOfA.id}/related`).expect(200)).body
    expect(rel).toEqual([expect.objectContaining({ object: expect.objectContaining({ key: 'hoc_sinh' }), total: 1, items: [{ id: hs.id, title: 'HS của A', code: expect.any(String) }] })])
    // định nghĩa kèm khoá thực thể đích (để FE dựng liên kết) — chỉ khi người xem thấy được thực thể đích
    const defA = (await api(app, a.token).get(`${BASE}/hoc_sinh`).expect(200)).body
    expect(defA.fields.find((x: { key: string }) => x.key === 'phu_huynh').options).toMatchObject({ target_object_id: phObj.id, target_key: 'phu_huynh' })
    const roleOfA = (await prisma.userRole.findFirstOrThrow({ where: { user_id: a.id } })).role_id
    const outsider = await mk({ 'custom_records.view': 'all' })
    await api(app, admin.token).patch(`${BASE}/phu_huynh`).send({ visible_role_ids: [roleOfA] }).expect(200)
    const defOutsider = (await api(app, outsider.token).get(`${BASE}/hoc_sinh`).expect(200)).body
    expect(defOutsider.fields.find((x: { key: string }) => x.key === 'phu_huynh').options.target_key).toBeUndefined()
    await api(app, admin.token).patch(`${BASE}/phu_huynh`).send({ visible_role_ids: [] }).expect(200)
    // xoá thực thể đích khi còn liên kết → 409
    await api(app, admin.token).delete(`${BASE}/phu_huynh`).expect(409)
    // lọc theo liên kết
    const f = (await api(app, admin.token).get(`${BASE}/hoc_sinh/records`).query({ filter: JSON.stringify({ phu_huynh: pOfA.id }) }).expect(200)).body
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
    for (const r of rows) await rec(t, 'hoc_sinh', r).expect(201)
    const get = async (q: Record<string, string>) => (await api(app, t).get(`${BASE}/hoc_sinh/records`).query(q).expect(200)).body
    const names = (b: { items: { data: { ten: string } }[] }) => b.items.map((x) => x.data.ten)
    // mặc định: mới nhất trước, cursor đi hết không trùng không sót
    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 5; i++) {
      const page = await get({ limit: '2', ...(cursor ? { cursor } : {}) })
      seen.push(...names(page))
      cursor = page.next_cursor ?? undefined
      if (!cursor) break
    }
    expect(seen).toEqual(['a_b', '100% đúng', 'Chi', 'Bình', 'An'])
    expect((await get({ limit: '2' })).total).toBe(5)
    // sắp xếp theo số, NULL luôn cuối (cả 2 chiều), phân trang bằng cursor khoá kép
    expect(names(await get({ sort: 'field:diem', dir: 'desc' }))).toEqual(['An', 'Bình', '100% đúng', 'a_b', 'Chi'])
    expect(names(await get({ sort: 'field:diem', dir: 'asc' }))).toEqual(['a_b', '100% đúng', 'Bình', 'An', 'Chi'])
    const s: string[] = []
    cursor = undefined
    for (let i = 0; i < 6; i++) {
      const page = await get({ sort: 'field:diem', dir: 'asc', limit: '2', ...(cursor ? { cursor } : {}) })
      s.push(...names(page))
      cursor = page.next_cursor ?? undefined
      if (!cursor) break
    }
    expect(s).toEqual(['a_b', '100% đúng', 'Bình', 'An', 'Chi'])
    expect(names(await get({ sort: 'title', dir: 'asc' }))[0]).toBe('100% đúng')
    // sắp xếp theo updated_at (kiểu timestamptz) cũng đi hết bằng cursor, không trùng không sót
    const u: string[] = []
    cursor = undefined
    for (let i = 0; i < 6; i++) {
      const page = await get({ sort: 'updated_at', dir: 'asc', limit: '2', ...(cursor ? { cursor } : {}) })
      u.push(...names(page))
      cursor = page.next_cursor ?? undefined
      if (!cursor) break
    }
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
    ]) await api(app, t).get(`${BASE}/hoc_sinh/records`).query(bad).expect(400)
    expect(await prisma.customRecord.count()).toBe(5)
  })

  it('xuất CSV: cần *.export, BOM UTF-8, nhãn thay mã, chống CSV-injection, cắt có báo rõ', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t)
    await mkField(t, 'hoc_sinh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(t, 'hoc_sinh', { label: 'TT', key: 'tt', type: 'select', options: { choices: [{ label: 'Đang học', value: 'hoc' }] } })
    await mkField(t, 'hoc_sinh', { label: 'Ngày', key: 'ngay', type: 'date' })
    await rec(t, 'hoc_sinh', { ten: '=HYPERLINK("http://evil")', tt: 'hoc', ngay: '2025-02-10' }).expect(201)
    await rec(t, 'hoc_sinh', { ten: 'Có, dấu "phẩy"' }).expect(201)
    const noExport = await mk({ 'custom_records.view': 'all' })
    await api(app, noExport.token).get(`${BASE}/hoc_sinh/records/export`).expect(403)
    const res = await api(app, t).get(`${BASE}/hoc_sinh/records/export`).expect(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['x-truncated']).toBe('false')
    expect(res.headers['x-exported-rows']).toBe('2')
    expect(res.text.charCodeAt(0)).toBe(0xfeff)
    expect(res.text).toContain("'=HYPERLINK")
    expect(res.text).toContain('Đang học')
    expect(res.text).toContain('10/02/2025')
    expect(res.text).toContain('"Có, dấu ""phẩy"""')
    // phạm vi xuất = GIAO của xem và xuất: export all nhưng view own → chỉ phần của mình
    const mine = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'own', 'custom_records.export': 'all' })
    await rec(mine.token, 'hoc_sinh', { ten: 'của tôi' }).expect(201)
    const own = await api(app, mine.token).get(`${BASE}/hoc_sinh/records/export`).expect(200)
    expect(own.headers['x-exported-rows']).toBe('1')
    expect(own.text).not.toContain('HYPERLINK')
  })

  it('outbox: tạo/sửa/xoá bản ghi ghi sự kiện custom_record.* cùng transaction (SĐT thô, che ở bước gửi)', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t, 'phu_huynh')
    await mkField(t, 'phu_huynh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(t, 'phu_huynh', { label: 'SĐT', key: 'sdt', type: 'phone' })
    await mkField(t, 'phu_huynh', { label: 'Tính', key: 'tinh', type: 'formula', options: { expression: '1+1' } })
    const r = (await rec(t, 'phu_huynh', { ten: 'A', sdt: '0900000123' }).expect(201)).body
    await api(app, t).patch(`${BASE}/phu_huynh/records/${r.id}`).send({ data: { ten: 'B' } }).expect(200)
    await api(app, t).delete(`${BASE}/phu_huynh/records/${r.id}`).expect(200)
    // lỗi validate KHÔNG ghi sự kiện
    await rec(t, 'phu_huynh', { sdt: 'xx' }).expect(400)
    const ev = await prisma.integrationEvent.findMany({ orderBy: { id: 'asc' } })
    expect(ev.map((e) => e.event_type)).toEqual(['custom_record.created', 'custom_record.updated', 'custom_record.deleted'])
    expect(ev.every((e) => e.resource === 'custom_record' && e.resource_id === String(r.id))).toBe(true)
    const created = ev[0].payload as { object: { key: string }; record: { phone_fields: string[]; data: Record<string, unknown> } }
    expect(created.object.key).toBe('phu_huynh')
    expect(created.record.phone_fields).toEqual(['sdt'])
    expect(created.record.data).toEqual({ ten: 'A', sdt: '0900000123' }) // không có trường công thức
    expect((ev[1].payload as { changed_fields: string[] }).changed_fields).toEqual(['ten'])
  })

  it('giới hạn: số thực thể, số trường, kích thước dữ liệu', async () => {
    const t = (await mk(ALL)).token
    await mkObject(t)
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú', key: 'gc', type: 'long_text' })
    const big = 'x'.repeat(9_000)
    const r = await rec(t, 'hoc_sinh', { gc: big }).expect(201)
    expect(r.body.id).toBeGreaterThan(0)
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú 2', key: 'gc2', type: 'long_text' })
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú 3', key: 'gc3', type: 'long_text' })
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú 4', key: 'gc4', type: 'long_text' })
    const e = await rec(t, 'hoc_sinh', { gc: big, gc2: big, gc3: big, gc4: big }).expect(400)
    expect(e.body.errors._data).toBeDefined()
    await api(app, t).post(`${BASE}/hoc_sinh/records`).send({ data: { gc: 'x'.repeat(10_001) } }).expect(400)
    for (let i = 0; i < 60; i++) {
      const res = await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: `T${i}`, key: `t${i}`, type: 'text' })
      if (res.status === 400) { expect(i).toBeGreaterThanOrEqual(55); return }
    }
    throw new Error('không chặn quá 60 trường')
  })

  it('các ca biên: SĐT không được đặt duy nhất, khoá trường trùng Object.prototype, nhãn rỗng, manage ⊄ view, user ngoài phạm vi, owner_id null, lost update, NUL/ngày sai', async () => {
    const admin = await mk(ALL)
    const t = admin.token
    await mkObject(t)
    await mkField(t, 'hoc_sinh', { label: 'Tên', key: 'ten', type: 'text' })
    await mkField(t, 'hoc_sinh', { label: 'Ghi chú', key: 'gc', type: 'long_text' })
    await mkField(t, 'hoc_sinh', { label: 'Người lo', key: 'nguoi', type: 'user' })
    // phone không được đặt duy nhất (oracle dò SĐT vòng qua phone_full)
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'SĐT', key: 'sdt', type: 'phone', is_unique: true }).expect(400)
    // khoá trùng thuộc tính Object.prototype
    for (const k of ['constructor', 'valueof', 'tostring', 'hasownproperty']) {
      const r = await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'X', key: k, type: 'text' })
      expect([201, 400]).toContain(r.status) // chữ thường không trùng; chỉ khoá TRÙNG THẬT bị chặn
    }
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: 'X', key: 'constructor', type: 'text' }).expect(400)
    // nhãn toàn khoảng trắng
    await api(app, t).post(BASE).send({ key: 'trang', label: '   ', label_plural: 'x' }).expect(400)
    await api(app, t).post(`${BASE}/hoc_sinh/fields`).send({ label: '   ', type: 'text' }).expect(400)
    // thiếu view → không ghi được; manage rộng hơn view → phản hồi tối giản, không rò dữ liệu
    const manageOnly = await mk({ 'custom_records.manage': 'all' })
    await rec(manageOnly.token, 'hoc_sinh', { ten: 'x' }).expect(403)
    const wide = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'all' })
    const other = (await rec(t, 'hoc_sinh', { ten: 'bí mật', gc: 'nội dung riêng' }).expect(201)).body
    const patched = await api(app, wide.token).patch(`${BASE}/hoc_sinh/records/${other.id}`).send({ data: { ten: 'sửa' } }).expect(200)
    expect(patched.body).toEqual({ id: other.id })
    await api(app, wide.token).get(`${BASE}/hoc_sinh/records/${other.id}`).expect(404)
    // trường user chỉ chọn người TRONG phạm vi; ngoài phạm vi → 400
    const boss = await mk({ 'custom_records.view': 'own', 'custom_records.manage': 'own' })
    const stranger = await mk({})
    const bad = await rec(boss.token, 'hoc_sinh', { ten: 'a', nguoi: stranger.id }).expect(400)
    expect(bad.body.errors.nguoi).toBeDefined()
    const okSelf = await rec(boss.token, 'hoc_sinh', { ten: 'b', nguoi: boss.id }).expect(201)
    expect(okSelf.body.relations.nguoi.accessible).toBe(true)
    // owner_id null = mặc định (không 500)
    const nul = await api(app, t).post(`${BASE}/hoc_sinh/records`).send({ data: { ten: 'c' }, owner_id: null }).expect(201)
    expect(nul.body.owner_id).toBe(admin.id)
    // 2 PATCH song song khác trường không ghi đè nhau
    const base = (await rec(t, 'hoc_sinh', { ten: 'goc' }).expect(201)).body
    const [a, b] = await Promise.all([
      api(app, t).patch(`${BASE}/hoc_sinh/records/${base.id}`).send({ data: { ten: 'moi' } }),
      api(app, t).patch(`${BASE}/hoc_sinh/records/${base.id}`).send({ data: { gc: 'ghi chú mới' } }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    const after = (await api(app, t).get(`${BASE}/hoc_sinh/records/${base.id}`).expect(200)).body
    expect(after.data).toMatchObject({ ten: 'moi', gc: 'ghi chú mới' })
    // con trỏ ngày sai, NUL trong q/filter
    const upd = Buffer.from(JSON.stringify({ v: '2026-02-30 10:00:00+00', id: 1 })).toString('base64url')
    await api(app, t).get(`${BASE}/hoc_sinh/records`).query({ sort: 'updated_at', cursor: upd }).expect(400)
    await api(app, t).get(`${BASE}/hoc_sinh/records?q=a%00b`).expect(400)
    await api(app, t).get(`${BASE}/hoc_sinh/records`).query({ filter: '{"nguoi":[1],"x":"\\u0000"}' }).expect(400)
    // long_text → text khi có giá trị > 500 ký tự
    await mkField(t, 'hoc_sinh', { label: 'Dài', key: 'dai', type: 'long_text' })
    await rec(t, 'hoc_sinh', { ten: 'long', dai: 'x'.repeat(600) }).expect(201)
    await api(app, t).patch(`${BASE}/hoc_sinh/fields/dai`).send({ type: 'text' }).expect(409)
  })
})
