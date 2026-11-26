import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { BASE, a, count, mk, resetCustom, st, type Body } from '../../lib/custom.js'
import { goldenThreeRoles } from '../../lib/roles.js'

afterAll(closeDb)
beforeEach(resetCustom)

/**
 * C09, từ `custom-objects-templates.e2e-spec.ts` (8 ca). Mẫu "Trung tâm giáo dục": áp mẫu tạo đủ 6 thực thể + liên kết + công thức,
 * chạy lại KHÔNG nhân đôi, dữ liệu mẫu GIẢ chỉ cho thực thể mới, quyền, giới hạn.
 */
const MANAGE = { 'custom_objects.manage': true, 'custom_records.view': 'all', 'custom_records.manage': 'all' } as const
const KEYS = ['phu_huynh', 'hoc_sinh', 'khoa_hoc', 'hoa_don', 'ghi_danh', 'thanh_toan']
const apply = (token: string, body: Record<string, unknown> = {}) => a(token).post(`${BASE}/templates/education_center/apply`, body)
const objectsWithKey = async (keys: string[]): Promise<number> => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM custom_objects WHERE key = ANY($1)`, [keys]))[0].n

describe('Mẫu tính năng', () => {
  it('thiếu custom_objects.manage → 403; mẫu lạ → 404; danh sách mẫu báo đã áp chưa', async () => {
    const none = await mk({ 'custom_records.view': 'all' })
    await st(a(none.token).get(`${BASE}/templates`), 403)
    await st(apply(none.token), 403)
    const admin = await mk(MANAGE)
    await st(a(admin.token).post(`${BASE}/templates/khong_co/apply`, {}), 404)
    const before = (await goldenThreeRoles('custom-templates-list-before', `${BASE}/templates`, admin.token)).body as Body
    expect(before[0]).toEqual(expect.objectContaining({ key: 'education_center', objects: expect.arrayContaining([{ key: 'hoc_sinh', label: 'Học sinh', applied: false }]) }))
    await st(apply(admin.token), 201)
    const after = (await st(a(admin.token).get(`${BASE}/templates`), 200)).body as Body
    expect(after[0].objects.every((o: { applied: boolean }) => o.applied)).toBe(true)
  })

  it('áp mẫu → 6 thực thể + trường + liên kết đúng; nav đủ & đúng thứ tự; chạy lại không nhân đôi', async () => {
    const admin = await mk(MANAGE)
    const r = (await st(apply(admin.token), 201)).body
    expect(r).toEqual({ created: KEYS, existing: [], sample_records: 0 })
    const nav = (await st(a(admin.token).get(`${BASE}/nav`), 200)).body as Body
    expect(nav.map((n: { key: string }) => n.key)).toEqual(KEYS)
    const ids = Object.fromEntries(((await st(a(admin.token).get(BASE), 200)).body as Body).map((o: { key: string; id: number }) => [o.key, o.id]))
    const def = async (k: string): Promise<Body> => (await st(a(admin.token).get(`${BASE}/${k}`), 200)).body
    const hs = await def('hoc_sinh')
    expect(hs.fields.map((f: { key: string }) => f.key)).toEqual(['ho_ten', 'tuoi', 'gioi_tinh', 'phu_huynh', 'tinh_trang_hoc', 'ma_he_thong', 'ghi_chu'])
    expect(hs.fields.find((f: { key: string }) => f.key === 'phu_huynh').options).toMatchObject({ target_object_id: ids.phu_huynh, target_key: 'phu_huynh' })
    expect(hs.fields.filter((f: { is_title: boolean }) => f.is_title).map((f: { key: string }) => f.key)).toEqual(['ho_ten'])
    const gd = await def('ghi_danh')
    expect(gd.fields.find((f: { key: string }) => f.key === 'hoa_don').options.target_object_id).toBe(ids.hoa_don)
    expect(gd.fields.find((f: { key: string }) => f.key === 'thuc_te_thang')).toMatchObject({ type: 'formula', options: { expression: 'round(months_between({bat_dau}, {ket_thuc}), 1)' } })
    const tt = await def('thanh_toan')
    expect(['hoa_don', 'phu_huynh', 'hoc_sinh'].map((k) => tt.fields.find((f: { key: string }) => f.key === k).options.target_object_id)).toEqual([ids.hoa_don, ids.phu_huynh, ids.hoc_sinh])
    // chạy lại: không nhân đôi, không đụng cấu hình đã có
    await st(a(admin.token).patch(`${BASE}/hoc_sinh`, { label_plural: 'Học viên' }), 200)
    const again = (await st(apply(admin.token, { with_sample_data: true }), 201)).body
    expect(again).toEqual({ created: [], existing: KEYS, sample_records: 0 })
    expect(await count('custom_objects')).toBe(6)
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM custom_fields f JOIN custom_objects o ON o.id = f.object_id WHERE o.key = 'hoc_sinh'`))[0].n).toBe(7)
    expect((await def('hoc_sinh')).label_plural).toBe('Học viên')
    expect(await count('custom_records')).toBe(0)
  })

  it('2 lần áp SONG SONG không nhân đôi', async () => {
    const admin = await mk(MANAGE)
    const [r1, r2] = await Promise.all([apply(admin.token), apply(admin.token)])
    expect([r1.status, r2.status]).toEqual([201, 201])
    expect(await count('custom_objects')).toBe(6)
    expect(await count('custom_fields')).toBe(47) // 4+7+9+8+10+9, không nhân đôi trường
    const created = [r1.body as Body, r2.body as Body].flatMap((x) => x.created).sort()
    expect(created).toEqual([...KEYS].sort())
  })

  it('dữ liệu mẫu GIẢ: đủ số lượng, liên kết đúng, công thức ra đúng bảng giá, SĐT giả 0900000xxx', async () => {
    const admin = await mk({ ...MANAGE, 'custom_records.phone_full': 'all' })
    const r = (await st(apply(admin.token, { with_sample_data: true }), 201)).body as Body
    expect(r.sample_records).toBe(20)
    const list = async (k: string): Promise<Body> => (await st(a(admin.token).get(`${BASE}/${k}/records`, { sort: 'id', dir: 'asc', limit: '100' }), 200)).body
    const ph = await list('phu_huynh')
    expect(ph.total).toBe(3)
    expect(ph.items.map((x: { data: { sdt: string } }) => x.data.sdt).sort()).toEqual(['0900000001', '0900000002', '0900000003'])
    expect(ph.items.every((x: { title: string }) => /^Phụ huynh Mẫu \d\d$/.test(x.title))).toBe(true)
    const hs = await list('hoc_sinh')
    expect(hs.total).toBe(4)
    expect(hs.items.every((x: { relations: { phu_huynh: { accessible: boolean } } }) => x.relations.phu_huynh.accessible)).toBe(true)
    const kh = await list('khoa_hoc')
    const byName = Object.fromEntries(kh.items.map((x: { title: string; data: Record<string, number> }) => [x.title, x.data]))
    expect(kh.items.length).toBeGreaterThan(0)
    for (const d of Object.values(byName) as Record<string, number>[]) {
      // công thức: thanh_toan = gia_goc × (1 − ưu đãi%)
      expect(d.thanh_toan).toBe(Math.round((d.gia_goc * (100 - d.uu_dai)) / 100))
      expect(d.don_gia_buoi).toBeGreaterThan(0)
    }
    const gd = await list('ghi_danh')
    expect(gd.total).toBe(3)
    expect(gd.items.every((x: { data: { thuc_te_thang: number } }) => x.data.thuc_te_thang > 0)).toBe(true)
    expect(gd.items[0].relations).toMatchObject({ hoc_sinh: { accessible: true }, khoa_hoc: { accessible: true }, hoa_don: { accessible: true } })
    expect((await list('hoa_don')).total).toBe(3)
    expect((await list('thanh_toan')).total).toBe(3)
    // liên quan ngược: Phụ huynh Mẫu 01 → Học sinh (2) + Hoá đơn + Thanh toán
    const rel = (await st(a(admin.token).get(`${BASE}/phu_huynh/records/${ph.items[0].id}/related`), 200)).body as Body
    expect(rel.map((g: { object: { key: string } }) => g.object.key).sort()).toEqual(['hoa_don', 'hoc_sinh', 'thanh_toan'])
    // đã sinh dữ liệu mẫu thì sửa một bản ghi vẫn hợp lệ qua API thường (ràng buộc duy nhất / bắt buộc)
    await st(a(admin.token).patch(`${BASE}/ghi_danh/records/${gd.items[0].id}`, { data: { trang_thai: 'hoan_thanh' } }), 200)
  })

  it('dữ liệu mẫu cần thêm quyền custom_records.manage; không có → 403 và KHÔNG tạo gì', async () => {
    const onlyConfig = await mk({ 'custom_objects.manage': true })
    await st(apply(onlyConfig.token, { with_sample_data: true }), 403)
    expect(await count('custom_objects')).toBe(0)
    await st(apply(onlyConfig.token), 201)
    expect(await count('custom_objects')).toBe(6)
  })

  it('thực thể trùng key do người dùng tự tạo được GIỮ NGUYÊN; chỉ tạo phần còn thiếu; dữ liệu mẫu chỉ cho phần mới', async () => {
    const admin = await mk(MANAGE)
    await st(a(admin.token).post(BASE, { key: 'phu_huynh', label: 'Người giám hộ', label_plural: 'Người giám hộ' }), 201)
    await st(a(admin.token).post(`${BASE}/phu_huynh/fields`, { label: 'Tên', key: 'ten', type: 'text' }), 201)
    const r = (await st(apply(admin.token, { with_sample_data: true }), 201)).body as Body
    expect(r.existing).toEqual(['phu_huynh'])
    expect(r.created).toEqual(KEYS.filter((k) => k !== 'phu_huynh'))
    expect(((await st(a(admin.token).get(`${BASE}/phu_huynh`), 200)).body as Body).fields.map((f: { key: string }) => f.key)).toEqual(['ten'])
    expect(((await st(a(admin.token).get(`${BASE}/phu_huynh/records`), 200)).body as Body).total).toBe(0) // không sinh mẫu cho thực thể cũ
    const hs = (await st(a(admin.token).get(`${BASE}/hoc_sinh/records`, { limit: '100' }), 200)).body as Body
    expect(hs.total).toBe(4)
    expect(hs.items[0].relations.phu_huynh).toBeUndefined() // không có bản ghi mẫu để liên kết
  })

  it('áp lại sau khi xoá một phần: KHÔNG sinh bản ghi mẫu thiếu trường liên kết bắt buộc', async () => {
    const admin = await mk(MANAGE)
    await st(apply(admin.token), 201)
    await st(a(admin.token).del(`${BASE}/ghi_danh`), 200)
    const r = (await st(apply(admin.token, { with_sample_data: true }), 201)).body as Body
    expect(r.created).toEqual(['ghi_danh'])
    expect(r.sample_records).toBe(0) // Ghi danh cần Học sinh (cũ, không có mẫu) ⇒ bỏ qua thay vì tạo bản ghi thiếu trường bắt buộc
    expect(((await st(a(admin.token).get(`${BASE}/ghi_danh/records`), 200)).body as Body).total).toBe(0)
  })

  it('giới hạn số tính năng: vượt 50 → 400 và không tạo nửa chừng', async () => {
    const admin = await mk(MANAGE)
    for (let i = 0; i < 46; i++) await st(a(admin.token).post(BASE, { key: `x${i}`, label: `X${i}`, label_plural: `X${i}` }), 201)
    await st(apply(admin.token), 400)
    expect(await count('custom_objects')).toBe(46)
    expect(await objectsWithKey(KEYS)).toBe(0)
  })
})
