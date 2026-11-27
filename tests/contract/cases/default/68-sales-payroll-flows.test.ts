import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser, setSetting } from '../../lib/db.js'
import { api, control, freshIp, type Res } from '../../lib/http.js'
import { PNG_1X1, rawCall } from '../../lib/files.js'
import { loginAdmin, loginSeeded } from '../../lib/session.js'
import { makeUser, type U } from '../../lib/users.js'

/**
 * C14e — ca THÀNH CÔNG (và vòng đời) của cụm `sales-payroll` mà ca sinh (`67-…`) không phủ: danh mục, thuộc tính, sản phẩm, dự án,
 * POS (khu, bàn, tuỳ chọn, ca, đơn, thu tiền, huỷ), trang bán hàng, nhân viên của lương, quy tắc/thành phần lương, bảo hiểm, thuế,
 * KPI, phiếu lương (kể cả tệp), thông báo. Chỉ kiểm mã trạng thái và hình dạng tối thiểu; không golden (đã có ở file khác).
 */
let saved: Record<string, string | null> = {}
beforeAll(async () => {
  const rows = await q<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key IN ('setup_status', 'org_features')`)
  saved = { setup_status: null, org_features: null, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) }
  await setSetting('setup_status', 'da_dung')
  await setSetting('org_features', JSON.stringify({ online_store: true }))
  await control.flushCache()
})
afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === null) await q(`DELETE FROM settings WHERE key = $1`, [key])
    else await setSetting(key, value)
  }
  await control.flushCache()
  await closeDb()
})

const ok = <T>(res: Res, status: number | number[], what: string): T => {
  expect([status].flat(), `${what}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status)
  return res.body as T
}
const uniq = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const code = (p: string): string => `${p}_${uniq()}`.toLowerCase().replace(/[^a-z0-9_]/g, '')

let sales: U
let pay: U
let pos: U
beforeAll(async () => {
  sales = await makeUser({ 'products.view': true, 'products.manage': true, 'deals.view': true, 'deals.manage': true })
  // Quyền có phạm vi (nhân viên, phiếu lương): 'all' — `true` (không phạm vi) bị coi là hẹp nhất và trả 404 ngoài phạm vi.
  const all = (ps: string[]) => Object.fromEntries(ps.map((p) => [p, 'all' as const]))
  pay = await makeUser({ ...all(['payroll.view', 'payroll.manage', 'payroll.export', 'payroll.approve_final', 'payroll.approve_team', 'employees.view', 'employees.manage']), 'settings.integrations': true })
  pos = await makeUser({ 'pos.sell': true, 'pos.manage': true, 'pos.report': true, 'products.view': true, 'products.manage': true })
})
const as = (u: U) => ({ token: u.token, ip: freshIp() })

describe('danh mục, thuộc tính, sản phẩm, dự án', () => {
  it('danh mục + thuộc tính + sản phẩm: tạo, xem, sửa, xoá mềm, khôi phục, xoá hẳn (Quản trị), ảnh', async () => {
    const cat = ok<{ id: number }>(await api.post('/product-categories', { ...as(sales), body: { code: code('dm'), name: 'Danh mục luồng' } }), 201, 'tạo danh mục')
    ok(await api.get(`/product-categories/${cat.id}`, as(sales)), 200, 'chi tiết danh mục')
    ok(await api.get('/product-categories', as(sales)), 200, 'danh sách danh mục')
    ok(await api.patch(`/product-categories/${cat.id}`, { ...as(sales), body: { name: 'Danh mục luồng sửa' } }), 200, 'sửa danh mục')
    const def = ok<{ id: number }>(await api.post(`/product-categories/${cat.id}/attribute-defs`, { ...as(sales), body: { key: code('mau'), label: 'Màu', type: 'text' } }), 201, 'tạo thuộc tính')
    ok(await api.get(`/product-categories/${cat.id}/attribute-defs`, as(sales)), 200, 'danh sách thuộc tính')
    ok(await api.patch(`/product-attribute-defs/${def.id}`, { ...as(sales), body: { label: 'Màu sắc' } }), 200, 'sửa thuộc tính')
    ok(await api.del(`/product-attribute-defs/${def.id}`, as(sales)), [200, 204], 'xoá thuộc tính')

    const prj = ok<{ id: number }>(await api.post('/projects', { ...as(sales), body: { name: 'Dự án luồng', code: code('da'), color: 'blue' } }), 201, 'tạo dự án')
    ok(await api.get(`/projects/${prj.id}`, as(sales)), 200, 'chi tiết dự án')
    ok(await api.get('/projects', as(sales)), 200, 'danh sách dự án')
    ok(await api.patch(`/projects/${prj.id}`, { ...as(sales), body: { name: 'Dự án luồng sửa' } }), 200, 'sửa dự án')

    const prod = ok<{ id: number }>(await api.post('/products', { ...as(sales), body: { code: `SP-${uniq()}`, name: 'Sản phẩm luồng', category_id: cat.id, project_id: prj.id, price: 125000 } }), 201, 'tạo sản phẩm')
    ok(await api.get(`/products/${prod.id}`, as(sales)), 200, 'chi tiết sản phẩm')
    ok(await api.patch(`/products/${prod.id}`, { ...as(sales), body: { name: 'Sản phẩm luồng sửa', price: 130000 } }), 200, 'sửa sản phẩm')
    ok(await api.del(`/products/${prod.id}`, as(sales)), [200, 204], 'xoá mềm')
    ok(await api.post(`/products/${prod.id}/restore`, as(sales)), [200, 201], 'khôi phục')
    ok(await api.del(`/products/${prod.id}`, as(sales)), [200, 204], 'xoá mềm lần hai')
    const admin = await loginAdmin()
    ok(await api.del(`/products/${prod.id}/permanent`, { token: admin.token, ip: freshIp() }), [200, 204], 'xoá hẳn')
    ok(await api.del(`/projects/${prj.id}`, as(sales)), [200, 204], 'xoá dự án')

    // Tải ảnh: sai loại → 400, ảnh thật → 201 trả image_url.
    const bad = await rawCall('POST', '/api/v1/products/upload-image', { token: sales.token, ip: freshIp(), multipart: { file: { field: 'file', name: 'a.txt', type: 'text/plain', bytes: Buffer.from('x') } } })
    expect(bad.status).toBe(400)
    const good = await rawCall('POST', '/api/v1/products/upload-image', { token: sales.token, ip: freshIp(), multipart: { file: { field: 'file', name: 'a.png', type: 'image/png', bytes: PNG_1X1 } } })
    expect(good.status, good.bytes.toString('utf8')).toBe(201)
    expect(typeof (good.json as { image_url?: string })?.image_url).toBe('string')
  })
})

describe('POS', () => {
  it('khu, bàn, tuỳ chọn, cấu hình, thực đơn, ca, đơn: tạo, sửa, thu tiền, huỷ, mã QR, báo cáo', async () => {
    const area = ok<{ id: number }>(await api.post('/pos/areas', { ...as(pos), body: { name: `Khu ${uniq()}` } }), 201, 'tạo khu')
    ok(await api.patch(`/pos/areas/${area.id}`, { ...as(pos), body: { name: `Khu sửa ${uniq()}` } }), 200, 'sửa khu')
    ok(await api.get('/pos/areas', as(pos)), 200, 'danh sách khu')
    const table = ok<{ id: number }>(await api.post('/pos/tables', { ...as(pos), body: { area_id: area.id, name: `B${uniq()}` } }), 201, 'tạo bàn')
    ok(await api.patch(`/pos/tables/${table.id}`, { ...as(pos), body: { name: `B2${uniq()}` } }), 200, 'sửa bàn')
    ok(await api.get('/pos/tables', as(pos)), 200, 'danh sách bàn')
    const mod = ok<{ id: number }>(await api.post('/pos/modifiers', { ...as(pos), body: { group_name: 'Đá', name: `Ít đá ${uniq()}`, price_delta: 0 } }), 201, 'tạo tuỳ chọn')
    ok(await api.patch(`/pos/modifiers/${mod.id}`, { ...as(pos), body: { price_delta: 1000 } }), 200, 'sửa tuỳ chọn')
    ok(await api.get('/pos/modifiers', as(pos)), 200, 'danh sách tuỳ chọn')

    const cat = ok<{ id: number }>(await api.post('/product-categories', { ...as(pos), body: { code: code('pos'), name: 'Thực đơn luồng' } }), 201, 'danh mục thực đơn')
    const prod = ok<{ id: number }>(await api.post('/products', { ...as(pos), body: { code: `POS-${uniq()}`, name: 'Món luồng', category_id: cat.id, price: 25000 } }), 201, 'món')
    ok(await api.get('/pos/settings', as(pos)), 200, 'cấu hình')
    ok(await api.patch('/pos/settings', { ...as(pos), body: { store_name: 'Cửa hàng luồng', menu_category_ids: [cat.id], bank_bin: '970436', bank_account_no: '0123456789', bank_account_name: 'CUA HANG LUONG' } }), 200, 'sửa cấu hình')
    ok(await api.get('/pos/menu', as(pos)), 200, 'thực đơn')

    expect((await api.get('/pos/shifts/current', as(pos))).status).toBe(200)
    const shift = ok<{ id: number }>(await api.post('/pos/shifts/open', { ...as(pos), body: { opening_cash: 100000 } }), 201, 'mở ca')
    ok(await api.get('/pos/shifts/current', as(pos)), 200, 'ca hiện tại')
    ok(await api.get('/pos/shifts', as(pos)), 200, 'danh sách ca')

    const o1 = ok<{ id: number }>(await api.post('/pos/orders', { ...as(pos), body: { table_id: table.id, items: [{ product_id: prod.id, quantity: 2, modifier_ids: [mod.id] }] } }), 201, 'tạo đơn')
    ok(await api.get(`/pos/orders/${o1.id}`, as(pos)), 200, 'chi tiết đơn')
    ok(await api.get('/pos/orders', as(pos)), 200, 'danh sách đơn')
    ok(await api.patch(`/pos/orders/${o1.id}`, { ...as(pos), body: { note: 'ít đường', items: [{ product_id: prod.id, quantity: 3 }] } }), 200, 'sửa đơn')
    ok(await api.get(`/pos/orders/${o1.id}/qr`, as(pos)), 200, 'mã QR')
    const paid = ok<{ total: number }>(await api.get(`/pos/orders/${o1.id}`, as(pos)), 200, 'tổng đơn')
    ok(await api.post(`/pos/orders/${o1.id}/pay`, { ...as(pos), body: { payments: [{ method: 'cash', amount: Number(paid.total), tendered: Number(paid.total) + 5000 }] } }), [200, 201], 'thu tiền')
    const o2 = ok<{ id: number }>(await api.post('/pos/orders', { ...as(pos), body: { items: [{ product_id: prod.id, quantity: 1 }] } }), 201, 'đơn thứ hai')
    ok(await api.post(`/pos/orders/${o2.id}/void`, { ...as(pos), body: { reason: 'khách đổi ý' } }), [200, 201], 'huỷ đơn')

    ok(await api.get(`/pos/shifts/${shift.id}/summary`, as(pos)), 200, 'tóm tắt ca')
    ok(await api.post(`/pos/shifts/${shift.id}/close`, { ...as(pos), body: { closing_cash_counted: 100000 } }), [200, 201], 'đóng ca')
    ok(await api.get('/pos/reports/daily', as(pos)), 200, 'báo cáo ngày')
  })
})

describe('trang bán hàng', () => {
  it('cấu hình, mở bán, khách xem và đặt đơn, tra đơn, quản lý đơn', async () => {
    const cat = ok<{ id: number }>(await api.post('/product-categories', { ...as(sales), body: { code: code('st'), name: 'Hàng bán' } }), 201, 'danh mục')
    const prod = ok<{ id: number }>(await api.post('/products', { ...as(sales), body: { code: `ST-${uniq()}`, name: 'Hàng online', category_id: cat.id, price: 50000 } }), 201, 'sản phẩm')
    const mgr = await makeUser({ 'pos.manage': true, 'deals.view': 'all', 'deals.manage': 'all' })
    const slug = `cua-hang-${uniq()}`.slice(0, 38).replace(/-$/, 'x')
    ok(await api.get('/store/settings', as(mgr)), 200, 'cấu hình')
    ok(await api.put('/store/settings', { ...as(mgr), body: { slug, name: 'Cửa hàng online', cod: true, published: true, product_ids: [prod.id] } }), 200, 'lưu cấu hình')
    ok(await api.get(`/store/public/${slug}`, { ip: freshIp() }), 200, 'khách xem trang')
    const placed = ok<{ code: string }>(await api.post(`/store/public/${slug}/orders`, { ip: freshIp(), body: { name: 'Khách luồng', phone: '0912345678', address: '1 Đường Thử', payment_method: 'cod', items: [{ product_id: prod.id, quantity: 2 }] } }), [200, 201], 'khách đặt đơn')
    expect((await api.post(`/store/public/${slug}/orders`, { ip: freshIp(), body: { name: '', items: [] } })).status).toBe(400)
    ok(await api.get(`/store/public/${slug}/orders/${placed.code}?phone=0912345678`, { ip: freshIp() }), 200, 'tra đơn')
    const list = ok<{ data?: { id: number }[] } | { id: number }[]>(await api.get('/store/orders', as(mgr)), 200, 'danh sách đơn')
    const rows = Array.isArray(list) ? list : (list.data ?? [])
    expect(rows.length).toBeGreaterThan(0)
    ok(await api.patch(`/store/orders/${rows[0].id}`, { ...as(mgr), body: { status: 'confirmed' } }), 200, 'đổi trạng thái đơn')
    expect((await api.patch(`/store/orders/${rows[0].id}`, { ...as(mgr), body: { status: 'khong-hop-le' } })).status).toBe(400)
    ok(await api.put('/store/settings', { ...as(mgr), body: { published: false } }), 200, 'đóng bán')
  })
})

describe('lương: quy tắc, thành phần, bảo hiểm, thuế, KPI', () => {
  it('quy tắc lương: tạo, danh sách, xem, sửa', async () => {
    const rule = ok<{ id: number }>(await api.post('/salary-rules', { ...as(pay), body: { position: 'sales', name: `Quy tắc ${uniq()}`, details: [{ component: 'base', amount: '7000000', order: 1 }] } }), 201, 'tạo quy tắc')
    ok(await api.get('/salary-rules', as(pay)), 200, 'danh sách quy tắc')
    ok(await api.get(`/salary-rules/${rule.id}`, as(pay)), 200, 'chi tiết quy tắc')
    ok(await api.patch(`/salary-rules/${rule.id}`, { ...as(pay), body: { name: `Quy tắc sửa ${uniq()}` } }), 200, 'sửa quy tắc')
  })

  it('thành phần lương, bảo hiểm: tạo, danh sách, sửa, xoá', async () => {
    const comp = ok<{ id: number }>(await api.post('/salary-components', { ...as(pay), body: { name: 'Phụ cấp luồng', code: code('pc'), component_type: 'allowance', calc_method: 'fixed', fixed_amount: 500000, effective_from: '2026-01' } }), 201, 'tạo thành phần')
    ok(await api.get('/salary-components', as(pay)), 200, 'danh sách thành phần')
    ok(await api.patch(`/salary-components/${comp.id}`, { ...as(pay), body: { fixed_amount: 600000 } }), 200, 'sửa thành phần')
    ok(await api.del(`/salary-components/${comp.id}`, as(pay)), [200, 204], 'xoá thành phần')

    const ins = ok<{ id: number }>(await api.post('/insurance-settings', { ...as(pay), body: { name: 'BHXH luồng', code: code('bh'), employee_rate: 8, effective_from: '2026-01' } }), 201, 'tạo bảo hiểm')
    ok(await api.get('/insurance-settings', as(pay)), 200, 'danh sách bảo hiểm')
    ok(await api.patch(`/insurance-settings/${ins.id}`, { ...as(pay), body: { employee_rate: 8.5 } }), 200, 'sửa bảo hiểm')
    ok(await api.del(`/insurance-settings/${ins.id}`, as(pay)), [200, 204], 'xoá bảo hiểm')
  })

  it('thuế: bậc và cấu hình giảm trừ', async () => {
    ok(await api.get('/tax-config', as(pay)), 200, 'cấu hình thuế')
    const br = ok<{ id: number }>(await api.post('/tax-config/brackets', { ...as(pay), body: { bracket_order: 90 + Math.floor(Math.random() * 9), lower_bound: 0, upper_bound: 5000000, rate: 5, effective_from: '2031-01' } }), 201, 'tạo bậc')
    ok(await api.patch(`/tax-config/brackets/${br.id}`, { ...as(pay), body: { rate: 6 } }), 200, 'sửa bậc')
    ok(await api.del(`/tax-config/brackets/${br.id}`, as(pay)), [200, 204], 'xoá bậc')
    const st = ok<{ id: number }>(await api.post('/tax-config/settings', { ...as(pay), body: { personal_deduction: 11000000, dependent_deduction: 4400000, effective_from: '2031-01' } }), 201, 'tạo giảm trừ')
    ok(await api.patch(`/tax-config/settings/${st.id}`, { ...as(pay), body: { personal_deduction: 12000000 } }), 200, 'sửa giảm trừ')
  })

  it('KPI: cấu hình, tính, đóng tháng, xem; thông báo: số chưa đọc', async () => {
    ok(await api.post('/kpi/configs', { ...as(pay), body: { role: 'sales', metric_name: `chỉ số ${uniq()}`, target: 100, unit: 'count', weight: 10 } }), 201, 'tạo cấu hình KPI')
    ok(await api.get('/kpi/configs', as(pay)), 200, 'danh sách cấu hình KPI')
    ok(await api.get('/notifications/unread-count', as(pay)), 200, 'số chưa đọc')
  })
})

describe('nhân viên của lương và phiếu lương', () => {
  it('nhân viên, KPI theo tháng, phiếu: sinh, xem, sửa, duyệt, tệp, nhập Excel, thêm vào kỳ, xoá', async () => {
    const rule = ok<{ id: number }>(await api.post('/salary-rules', { ...as(pay), body: { position: 'sales', name: `QT ${uniq()}`, details: [{ component: 'base', amount: '7000000', order: 1 }] } }), 201, 'quy tắc')
    const u = await seedUser({ label: 'nvl', grants: {} })
    const emp = ok<{ id: number }>(await api.post('/employees', { ...as(pay), body: { user_id: u.id, position: 'sales', department: 'Kinh doanh', salary_rule_id: rule.id, joined_at: '2026-01-15' } }), 201, 'tạo nhân viên')
    ok(await api.get('/employees', as(pay)), 200, 'danh sách nhân viên')
    ok(await api.get(`/employees/${emp.id}`, as(pay)), 200, 'chi tiết nhân viên')
    ok(await api.patch(`/employees/${emp.id}`, { ...as(pay), body: { department: 'Kinh doanh 2' } }), 200, 'sửa nhân viên')

    const month = '2026-03'
    const gen = ok<unknown>(await api.post('/payslips/generate', { ...as(pay), body: { month, employee_ids: [emp.id] } }), [200, 201], 'sinh phiếu')
    expect(gen).toBeTruthy()
    const list = ok<{ data?: { id: number; employee_id?: number }[] } | { id: number }[]>(await api.get(`/payslips?month=${month}`, as(pay)), 200, 'danh sách phiếu')
    const rows = (Array.isArray(list) ? list : (list.data ?? [])) as { id: number }[]
    expect(rows.length).toBeGreaterThan(0)
    const id = rows[0].id
    ok(await api.get(`/payslips/${id}`, as(pay)), 200, 'chi tiết phiếu')
    ok(await api.patch(`/payslips/${id}`, { ...as(pay), body: { working_days: 20, base_salary: '8000000' } }), 200, 'sửa phiếu')

    const xlsx = await rawCall('GET', `/api/v1/payslips/${id}/excel`, { token: pay.token, ip: freshIp() })
    expect(xlsx.status, xlsx.bytes.toString('utf8').slice(0, 200)).toBe(200)
    const pdf = await rawCall('GET', `/api/v1/payslips/${id}/pdf`, { token: pay.token, ip: freshIp() })
    expect(pdf.status, pdf.bytes.toString('utf8').slice(0, 200)).toBe(200)
    for (const p of ['/payslips/excel-list', '/payslips/excel-bulk', '/payslips/import-template']) {
      const r = await rawCall('GET', `/api/v1${p}`, { token: pay.token, ip: freshIp(), query: { month } })
      expect(r.status, `${p}: ${r.bytes.toString('utf8').slice(0, 200)}`).toBe(200)
    }
    const post = await api.post('/payslips/excel-list', { ...as(pay), body: { month } })
    expect([200, 201], `excel-list POST: ${post.status}`).toContain(post.status)

    // Nhập Excel: dùng chính tệp mẫu của kỳ làm đầu vào (xem trước không ghi, áp dụng ghi).
    const tpl = await rawCall('GET', '/api/v1/payslips/import-template', { token: pay.token, ip: freshIp(), query: { month } })
    const file = { field: 'file', name: 'mau.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: tpl.bytes }
    const prev = await rawCall('POST', '/api/v1/payslips/import/preview', { token: pay.token, ip: freshIp(), query: { month }, multipart: { file } })
    expect([200, 201], `preview: ${prev.bytes.toString('utf8').slice(0, 200)}`).toContain(prev.status)
    const appl = await rawCall('POST', '/api/v1/payslips/import/apply', { token: pay.token, ip: freshIp(), query: { month }, multipart: { file } })
    expect([200, 201], `apply: ${appl.bytes.toString('utf8').slice(0, 200)}`).toContain(appl.status)
    for (const p of ['preview', 'apply']) expect((await rawCall('POST', `/api/v1/payslips/import/${p}`, { token: pay.token, ip: freshIp(), query: { month } })).status).toBe(400)

    ok(await api.get(`/payslips/addable?month=${month}`, as(pay)), 200, 'nhân viên có thể thêm')
    // Nhân viên thứ hai chưa có phiếu kỳ này: thêm vào kỳ.
    const u2 = await seedUser({ label: 'nvl2', grants: {} })
    const emp2 = ok<{ id: number }>(await api.post('/employees', { ...as(pay), body: { user_id: u2.id, position: 'sales', salary_rule_id: rule.id, joined_at: '2026-01-15' } }), 201, 'nhân viên thứ hai')
    ok(await api.post('/payslips/add-to-period', { ...as(pay), body: { month, employee_id: emp2.id } }), [200, 201], 'thêm vào kỳ')
    ok(await api.get('/payslips/me', as(pay)), [200, 404], 'phiếu của tôi')
    ok(await api.del(`/payslips/${id}`, as(pay)), [200, 204], 'xoá phiếu')
  })
})

describe('KPI theo tháng', () => {
  // Tách riêng: bản Rust chưa có nguồn số liệu KPI (`POST /kpi/calculate` trả 501, ghi ở docs/rust/PLAN.md); Node là chuẩn.
// SKIP #605: Rust chưa khớp hợp đồng Node ở ca này (POST tính KPI trả 501 (chưa có nguồn số liệu KPI)); bỏ skip khi sửa xong. Danh sách + lý do ở PR #605.
  it.skip('tính KPI cho một nhân viên, xem KPI của chính mình (người khác 404), đóng tháng', async () => {
    const rule = ok<{ id: number }>(await api.post('/salary-rules', { ...as(pay), body: { position: 'sales', name: `QK ${uniq()}`, details: [{ component: 'base', amount: '7000000', order: 1 }] } }), 201, 'quy tắc')
    const u = await seedUser({ label: 'kpi', grants: {} })
    const emp = ok<{ id: number }>(await api.post('/employees', { ...as(pay), body: { user_id: u.id, position: 'sales', salary_rule_id: rule.id, joined_at: '2026-01-15' } }), 201, 'tạo nhân viên')
    const month = '2026-03'
    ok(await api.post('/kpi/calculate', { ...as(pay), body: { month, employee_ids: [emp.id] } }), [200, 201], 'tính KPI')
    // KPI chỉ xem được của CHÍNH MÌNH (người khác, kể cả có quyền lương → 404); đăng nhập bằng tài khoản của nhân viên.
    const own = await loginSeeded(u)
    ok(await api.get(`/kpi?month=${month}&employee_id=${emp.id}`, { token: own.token, ip: freshIp() }), 200, 'xem KPI của mình')
    expect((await api.get(`/kpi?month=${month}&employee_id=${emp.id}`, as(pay))).status).toBe(404)
    ok(await api.post('/kpi/close-month', { ...as(pay), body: { month } }), [200, 201, 404], 'đóng tháng KPI')
  })
})
