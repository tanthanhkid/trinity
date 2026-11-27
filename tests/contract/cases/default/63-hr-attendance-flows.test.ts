import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser } from '../../lib/db.js'
import { api, freshIp, type Res } from '../../lib/http.js'
import { PDF_MIN, PNG_1X1, rawCall, type RawRes } from '../../lib/files.js'
import { golden } from '../../lib/golden.js'
import { loginAdmin, loginSeeded } from '../../lib/session.js'
import { makeUser, type U } from '../../lib/users.js'
import { readXlsx, snapXlsx } from '../../lib/xlsx.js'

afterAll(closeDb)

/**
 * C14d — ca thành công, đầu vào sai và không tồn tại của cụm `hr-attendance` mà ca sinh (`62-…`) và file chuyển từ e2e (`10-nhan-su`)
 * chưa phủ: nhân viên, hợp đồng (kèm tệp), chấm công (kèm selfie và ảnh minh chứng), đơn chấm công, tuyển dụng, team, chức danh.
 * Mười route xuất Excel được so THEO Ô (`snapXlsx`, golden Node ↔ Rust); không so byte của zip. Cụm này không có route đổi hình dạng
 * theo `contacts.phone_full` (`shape_permissions` rỗng) nên không có golden 3 vai.
 */
const ok = <T>(res: Res, status: number | number[], what: string): T => {
  expect([status].flat(), `${what}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status)
  return res.body as T
}
const as = (u: U) => ({ token: u.token, ip: freshIp() })
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const uniq = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

let hr: U

beforeAll(async () => {
  const perms = ['employees.view', 'employees.manage', 'employees.export', 'attendance.view', 'attendance.manage', 'attendance.config', 'attendance.export',
    'contracts.view', 'contracts.manage', 'recruitment.view', 'recruitment.manage', 'org.manage', 'users.manage', 'users.view']
  hr = await makeUser(Object.fromEntries(perms.map((p) => [p, 'all' as const])))
})

/** Gọi tệp (xlsx, ảnh, pdf) bằng token và IP riêng. */
const file = (path: string, token: string, query?: Record<string, string>): Promise<RawRes> => rawCall('GET', path, { token, ip: freshIp(), query })

async function exportXlsx(path: string, name: string, query?: Record<string, string>): Promise<void> {
  const res = await file(`/api/v1${path}`, hr.token, query)
  expect(res.status, `${path}: ${res.bytes.toString('utf8').slice(0, 200)}`).toBe(200)
  expect(res.headers.get('content-type') ?? '').toContain(XLSX)
  const sheets = readXlsx(res.bytes)
  expect(sheets.length, `${path}: không có bảng nào`).toBeGreaterThan(0)
  golden(name, 'admin', snapXlsx(res))
}

describe('nhân viên', () => {
  it('tạo, xem, sửa, thống kê, danh sách, sinh nhật; khoá bằng người có quyền, mở khoá CHỈ Quản trị, xoá', async () => {
    const email = `hr-emp-${uniq()}@contract.test`
    const created = ok<{ id: number; user_id?: number }>(await api.post('/management/employees', { ...as(hr), body: { email, full_name: 'NV Luồng', position: 'NV', department: 'Kinh doanh', gender: 'F', phone: '0900111222' } }), 201, 'tạo nhân viên')
    const id = created.id
    ok(await api.get(`/management/employees/${id}`, as(hr)), 200, 'chi tiết')
    ok(await api.patch(`/management/employees/${id}`, { ...as(hr), body: { full_name: 'NV Luồng Sửa' } }), 200, 'sửa')
    for (const p of ['/management/employees', '/management/employees/stats', '/management/employees/hr-stats', '/management/employees/birthdays']) ok(await api.get(p, as(hr)), 200, p)
    // Đầu vào sai: thân thiếu trường bắt buộc / email hỏng.
    expect((await api.post('/management/employees', { ...as(hr), body: { email: 'khong-phai-email', full_name: 'x' } })).status).toBe(400)
    expect((await api.patch(`/management/employees/${id}`, { ...as(hr), body: { gender: 'Z' } })).status).toBe(400)
    // Khoá rồi mở khoá: người dùng thường KHÔNG mở khoá được (403), Quản trị mở được (và chỉ khi đang khoá).
    ok(await api.patch(`/management/employees/${id}/lock`, as(hr)), 200, 'khoá')
    expect((await api.patch(`/management/employees/${id}/unlock`, as(hr))).status).toBe(403)
    const admin = await loginAdmin()
    ok(await api.patch(`/management/employees/${id}/unlock`, { token: admin.token, ip: freshIp() }), 200, 'mở khoá')
    expect((await api.patch(`/management/employees/${id}/unlock`, { token: admin.token, ip: freshIp() })).status).toBe(409)
    ok(await api.del(`/management/employees/${id}`, as(hr)), 200, 'xoá')
    // Xoá mềm: hồ sơ không còn trong danh sách (dòng vẫn đọc được theo id).
    const list = ok<{ data: { id: number }[] }>(await api.get('/management/employees', as(hr)), 200, 'danh sách sau xoá')
    expect(list.data.some((e) => e.id === id)).toBe(false)
  })

  it('xuất Excel: danh sách nhân viên và sinh nhật, so theo ô', async () => {
    await exportXlsx('/management/employees/export', 'hr-employees-export')
    await exportXlsx('/management/employees/birthdays/export', 'hr-birthdays-export')
  })
})

describe('hợp đồng', () => {
  it('tạo, xem, sửa, thống kê; tệp hợp đồng: tải lên, tải về, xoá; xoá hợp đồng', async () => {
    const [emp] = await q<{ id: number }>(`INSERT INTO employees (user_id, position, status) VALUES ((SELECT id FROM users ORDER BY id DESC LIMIT 1), 'NV', 'active') ON CONFLICT (user_id) DO UPDATE SET position = 'NV' RETURNING id`)
    const created = ok<{ id: number }>(await api.post('/management/contracts', { ...as(hr), body: { employee_id: emp.id, signed_date: '2026-01-01', contract_type: 'hdld_1', end_date: '2027-01-01', notes: 'ghi chú' } }), 201, 'tạo hợp đồng')
    const id = created.id
    ok(await api.get(`/management/contracts/${id}`, as(hr)), 200, 'chi tiết')
    ok(await api.patch(`/management/contracts/${id}`, { ...as(hr), body: { notes: 'đã sửa' } }), 200, 'sửa')
    ok(await api.get('/management/contracts/stats', as(hr)), 200, 'thống kê')
    expect((await api.post('/management/contracts', { ...as(hr), body: { employee_id: emp.id, signed_date: 'không phải ngày' } })).status).toBe(400)

    // Tệp: loại không cho phép → 400; PDF → 201; tải về đúng byte; xoá; tải lại → 404.
    const bad = await rawCall('POST', `/api/v1/management/contracts/${id}/file`, { token: hr.token, ip: freshIp(), multipart: { file: { field: 'file', name: 'x.exe', type: 'application/x-msdownload', bytes: Buffer.from('MZ') } } })
    expect(bad.status).toBe(400)
    const up = await rawCall('POST', `/api/v1/management/contracts/${id}/file`, { token: hr.token, ip: freshIp(), multipart: { file: { field: 'file', name: 'hop-dong.pdf', type: 'application/pdf', bytes: PDF_MIN } } })
    expect(up.status, up.bytes.toString('utf8')).toBe(201)
    const dl = await file(`/api/v1/management/contracts/${id}/file`, hr.token)
    expect(dl.status).toBe(200)
    expect(dl.bytes.equals(PDF_MIN)).toBe(true)
    expect((await rawCall('DELETE', `/api/v1/management/contracts/${id}/file`, { token: hr.token, ip: freshIp() })).status).toBe(200)
    expect((await file(`/api/v1/management/contracts/${id}/file`, hr.token)).status).toBe(404)
    // Tải tệp lên hợp đồng không tồn tại → 404 (tệp hợp lệ, nên không phải lỗi 400 thiếu tệp).
    const ghost = await rawCall('POST', '/api/v1/management/contracts/2147000000/file', { token: hr.token, ip: freshIp(), multipart: { file: { field: 'file', name: 'x.pdf', type: 'application/pdf', bytes: PDF_MIN } } })
    expect(ghost.status).toBe(404)
    ok(await api.del(`/management/contracts/${id}`, as(hr)), 200, 'xoá hợp đồng')
    expect((await api.get(`/management/contracts/${id}`, as(hr))).status).toBe(404)
  })

  it('hồ sơ mẫu: tải lên, liệt kê, tải về, xoá; tệp sai loại và id lạ', async () => {
    const bytes = Buffer.from('PK-mau-hop-dong')
    const bad = await rawCall('POST', '/api/v1/management/contracts/templates', { token: hr.token, ip: freshIp(), multipart: { fields: { name: 'x' }, file: { field: 'file', name: 'x.png', type: 'image/png', bytes: PNG_1X1 } } })
    expect(bad.status).toBe(400)
    const up = await rawCall('POST', '/api/v1/management/contracts/templates', { token: hr.token, ip: freshIp(), multipart: { fields: { name: `Mẫu ${uniq()}` }, file: { field: 'file', name: 'mau.xlsx', type: XLSX, bytes } } })
    expect(up.status, up.bytes.toString('utf8')).toBe(201)
    const tid = (up.json as { id: number }).id
    const list = ok<{ id: number }[] | { data: { id: number }[] }>(await api.get('/management/contracts/templates', as(hr)), 200, 'danh sách mẫu')
    expect((Array.isArray(list) ? list : list.data).some((t) => t.id === tid)).toBe(true)
    const dl = await file(`/api/v1/management/contracts/templates/${tid}/file`, hr.token)
    expect(dl.status).toBe(200)
    expect(dl.bytes.equals(bytes)).toBe(true)
    expect((await rawCall('DELETE', `/api/v1/management/contracts/templates/${tid}`, { token: hr.token, ip: freshIp() })).status).toBe(200)
    expect((await file(`/api/v1/management/contracts/templates/${tid}/file`, hr.token)).status).toBe(404)
  })
})

describe('tuyển dụng', () => {
  it('vị trí: tạo, liệt kê, sửa, xoá; ứng viên: tạo, sửa, xoá; người tuyển dụng và thống kê', async () => {
    const pos = ok<{ id: number }>(await api.post('/management/recruitment/positions', { ...as(hr), body: { job_code: `JC${uniq()}`, department: 'Kinh doanh', position_title: 'Sale', headcount: 2, recruiter_id: hr.id, opened_date: '2026-01-01' } }), 201, 'tạo vị trí')
    ok(await api.get('/management/recruitment/positions', as(hr)), 200, 'danh sách vị trí')
    ok(await api.patch(`/management/recruitment/positions/${pos.id}`, { ...as(hr), body: { headcount: 3 } }), 200, 'sửa vị trí')
    expect((await api.post('/management/recruitment/positions', { ...as(hr), body: { job_code: 'x' } })).status).toBe(400)
    const cand = ok<{ id: number }>(await api.post('/management/recruitment/candidates', { ...as(hr), body: { full_name: 'Ứng viên Luồng', position: 'Sale', stage: 'applied' } }), 201, 'tạo ứng viên')
    ok(await api.patch(`/management/recruitment/candidates/${cand.id}`, { ...as(hr), body: { stage: 'interview' } }), 200, 'sửa ứng viên')
    expect((await api.post('/management/recruitment/candidates', { ...as(hr), body: { full_name: 'x', stage: 'khong-co' } })).status).toBe(400)
    for (const p of ['/management/recruitment/recruiters', '/management/recruitment/stats']) ok(await api.get(p, as(hr)), 200, p)
    ok(await api.del(`/management/recruitment/candidates/${cand.id}`, as(hr)), 200, 'xoá ứng viên')
    ok(await api.del(`/management/recruitment/positions/${pos.id}`, as(hr)), 200, 'xoá vị trí')
    expect((await api.del(`/management/recruitment/positions/${pos.id}`, as(hr))).status).toBe(404)
  })
})

describe('team và chức danh', () => {
  it('team: tạo, sửa, thành viên (thêm, liệt kê, bỏ), bộ lọc; xoá', async () => {
    const member = await seedUser({ label: 'team-member', grants: {} })
    await q(`INSERT INTO employees (user_id, position, status) VALUES ($1, 'NV', 'active')`, [member.id])
    const t = ok<{ id: number }>(await api.post('/management/teams', { ...as(hr), body: { name: `Team ${uniq()}` } }), 201, 'tạo team')
    ok(await api.patch(`/management/teams/${t.id}`, { ...as(hr), body: { description: 'mô tả' } }), 200, 'sửa team')
    expect((await api.post('/management/teams', { ...as(hr), body: { name: '' } })).status).toBe(400)
    ok(await api.post(`/management/teams/${t.id}/members`, { ...as(hr), body: { user_ids: [member.id] } }), 201, 'thêm thành viên')
    ok(await api.get(`/management/teams/${t.id}/members`, as(hr)), 200, 'thành viên')
    for (const p of ['/management/teams/lead-filter', '/management/teams/for-filter']) ok(await api.get(p, as(hr)), 200, p)
    ok(await api.del(`/management/teams/${t.id}/members/${member.id}`, as(hr)), 200, 'bỏ thành viên')
    ok(await api.del(`/management/teams/${t.id}`, as(hr)), 200, 'xoá team')
    expect((await api.get(`/management/teams/${t.id}/members`, as(hr))).status).toBe(404)
  })

  it('chức danh: tạo, xem, sửa, xoá', async () => {
    const body = { category: 'Nhân viên', rank_code: `RC${uniq()}`, name: 'Chuyên viên', symbol: 'CV', review_cycle_months: 6 }
    const jt = ok<{ id: number }>(await api.post('/management/job-titles', { ...as(hr), body }), 201, 'tạo')
    ok(await api.get(`/management/job-titles/${jt.id}`, as(hr)), 200, 'xem')
    ok(await api.patch(`/management/job-titles/${jt.id}`, { ...as(hr), body: { name: 'Chuyên viên cao cấp' } }), 200, 'sửa')
    expect((await api.post('/management/job-titles', { ...as(hr), body: { category: 'x' } })).status).toBe(400)
    ok(await api.del(`/management/job-titles/${jt.id}`, as(hr)), 200, 'xoá')
    expect((await api.get(`/management/job-titles/${jt.id}`, as(hr))).status).toBe(404)
  })
})

describe('chấm công', () => {
  it('văn phòng: tạo, liệt kê, sửa, xoá; cấu hình ca, đơn, thứ bảy làm việc: đọc và sửa; đầu vào sai', async () => {
    const off = ok<{ id: number }>(await api.post('/management/attendance/offices', { ...as(hr), body: { name: `VP ${uniq()}`, ips: ['203.0.113.9'] } }), 201, 'tạo văn phòng')
    ok(await api.get('/management/attendance/offices', as(hr)), 200, 'danh sách văn phòng')
    ok(await api.patch(`/management/attendance/offices/${off.id}`, { ...as(hr), body: { description: 'mô tả' } }), 200, 'sửa văn phòng')
    expect((await api.post('/management/attendance/offices', { ...as(hr), body: { name: 'x', ips: [] } })).status).toBe(400)
    ok(await api.del(`/management/attendance/offices/${off.id}`, as(hr)), 200, 'xoá văn phòng')
    expect((await api.del(`/management/attendance/offices/${off.id}`, as(hr))).status).toBe(404)

    ok(await api.get('/management/attendance/settings', as(hr)), 200, 'đọc cấu hình ca')
    ok(await api.patch('/management/attendance/settings', { ...as(hr), body: { work_start: '08:00', work_end: '17:30', late_after: '08:10' } }), 200, 'sửa cấu hình ca')
    expect((await api.patch('/management/attendance/settings', { ...as(hr), body: { work_start: '25:00', work_end: '17:30', late_after: '08:10' } })).status).toBe(400)

    ok(await api.get('/management/attendance/request-config', as(hr)), 200, 'đọc cấu hình đơn')
    ok(await api.patch('/management/attendance/request-config', { ...as(hr), body: { default_check_in: '08:00', default_check_out: '17:30', monthly_forgot_limit: 3, monthly_late_early_limit: 3 } }), 200, 'sửa cấu hình đơn')
    expect((await api.patch('/management/attendance/request-config', { ...as(hr), body: { default_check_in: 'x' } })).status).toBe(400)

    ok(await api.get('/management/attendance/working-saturdays', as(hr)), 200, 'đọc thứ bảy')
    ok(await api.patch('/management/attendance/working-saturdays', { ...as(hr), body: { dates: ['2026-06-06'] } }), 200, 'sửa thứ bảy')
    expect((await api.patch('/management/attendance/working-saturdays', { ...as(hr), body: { dates: ['06/06/2026'] } })).status).toBe(400)
  })

  it('chấm công vào/ra bằng selfie, xem bản ghi và ảnh minh chứng, sửa, xoá; thiếu selfie và slot sai', async () => {
    // Văn phòng khớp IP khách (qua TRUSTED_PROXY), nhân viên có hồ sơ nhân sự.
    const ip = freshIp()
    const off = ok<{ id: number }>(await api.post('/management/attendance/offices', { ...as(hr), body: { name: `VP chấm ${uniq()}`, ips: [ip] } }), 201, 'văn phòng chấm công')
    const worker = await seedUser({ label: 'checkin', grants: {} })
    await q(`INSERT INTO employees (user_id, position, status) VALUES ($1, 'NV', 'active')`, [worker.id])
    const { token } = await loginSeeded(worker)
    const post = (p: string, fields: Record<string, string>, withSelfie: boolean) =>
      rawCall('POST', `/api/v1/management/attendance/${p}`, { token, ip, multipart: { fields, ...(withSelfie ? { file: { field: 'selfie', name: 's.png', type: 'image/png', bytes: PNG_1X1 } } : {}) } })

    expect((await post('check-in', { device_id: 'dev-1' }, false)).status).toBe(400) // thiếu selfie
    const inn = await post('check-in', { device_id: 'dev-1', note: 'vào' }, true)
    expect(inn.status, inn.bytes.toString('utf8')).toBe(201)
    const out = await post('check-out', { device_id: 'dev-1' }, true)
    expect(out.status, out.bytes.toString('utf8')).toBe(201)
    ok(await api.get('/management/attendance/today', { token, ip: freshIp() }), 200, 'hôm nay')

    const rec = (inn.json as { record: { id: number } }).record.id
    ok(await api.get(`/management/attendance/${rec}`, as(hr)), 200, 'chi tiết bản ghi')
    expect((await file(`/api/v1/management/attendance/${rec}/proof/in`, hr.token)).status).toBe(200)
    expect((await file(`/api/v1/management/attendance/${rec}/proof/out`, hr.token)).status).toBe(200)
    expect((await file(`/api/v1/management/attendance/${rec}/proof/khac`, hr.token)).status).toBe(400)
    ok(await api.patch(`/management/attendance/${rec}`, { ...as(hr), body: { check_in_note: 'đã sửa', status: 'present' } }), 200, 'sửa bản ghi')
    expect((await api.patch(`/management/attendance/${rec}`, { ...as(hr), body: { status: 'khong-co' } })).status).toBe(400)
    ok(await api.post(`/management/attendance/reset-device/${worker.id}`, as(hr)), 201, 'đặt lại thiết bị')
    ok(await api.del(`/management/attendance/${rec}`, as(hr)), 200, 'xoá bản ghi')
    expect((await api.get(`/management/attendance/${rec}`, as(hr))).status).toBe(404)
    ok(await api.del(`/management/attendance/offices/${off.id}`, as(hr)), 200, 'dọn văn phòng')
  })

  it('đơn chấm công: tạo, liệt kê, duyệt, từ chối; đầu vào sai', async () => {
    const worker = await seedUser({ label: 'request', grants: {} })
    await q(`INSERT INTO employees (user_id, position, status) VALUES ($1, 'NV', 'active')`, [worker.id])
    const { token } = await loginSeeded(worker)
    const mk = async (date: string) => ok<{ id: number }>(await api.post('/management/attendance/requests', { token, ip: freshIp(), body: { work_date: date, type: 'forgot_check_in', requested_check_in: '08:05', reason: 'Quên chấm' } }), 201, 'tạo đơn')
    const a = await mk('2026-01-05')
    const b = await mk('2026-01-06')
    expect((await api.post('/management/attendance/requests', { token, ip: freshIp(), body: { work_date: 'x', type: 'khac', reason: '' } })).status).toBe(400)
    ok(await api.get('/management/attendance/requests', as(hr)), 200, 'danh sách đơn')
    ok(await api.post(`/management/attendance/requests/${a.id}/approve`, as(hr)), 201, 'duyệt')
    ok(await api.post(`/management/attendance/requests/${b.id}/reject`, { ...as(hr), body: { review_note: 'không hợp lệ' } }), 201, 'từ chối')
    expect((await api.post(`/management/attendance/requests/${b.id}/reject`, { ...as(hr), body: { review_note: 'x'.repeat(501) } })).status).toBe(400)
  })

  it('thống kê và danh sách (có dữ liệu chấm công trong tháng)', async () => {
    const worker = await seedUser({ label: 'stats', grants: {} })
    const [e] = await q<{ id: number }>(`INSERT INTO employees (user_id, position, status, department, gender) VALUES ($1, 'NV', 'active', 'Kinh doanh', 'F') RETURNING id`, [worker.id])
    // Giờ vào/ra cố định theo ngày (không theo đồng hồ lúc chạy): file xuất Excel phải giống nhau giữa các lượt.
    for (const d of [1, 2, 3]) {
      await q(`INSERT INTO attendance_records (user_id, employee_id, work_date, check_in_at, check_out_at, total_hours, late_minutes, status, updated_at)
               VALUES ($1, $2, (now() - ($3 || ' days')::interval)::date, (now() - ($3 || ' days')::interval)::date + interval '2 hours', (now() - ($3 || ' days')::interval)::date + interval '10 hours', 8, $4, 'present', now())`, [worker.id, e.id, String(d), d === 1 ? 15 : 0])
    }
    for (const p of [
      '/management/attendance', '/management/attendance/absent', '/management/attendance/stats', '/management/attendance/stats/discipline',
      '/management/attendance/stats/filters', '/management/attendance/stats/leave-analytics', '/management/attendance/stats/monthly',
      '/management/attendance/stats/weekly', '/management/attendance/stats/weekly-hours', '/management/attendance/workdays-matrix',
    ]) ok(await api.get(p, as(hr)), 200, p)
  })

  it('xuất Excel chấm công: bản ghi, vắng mặt, năm bảng thống kê, ma trận công; so theo ô', async () => {
    // Mọi bản ghi còn lại về giờ cố định theo ngày làm việc (các file ca khác có thể để lại giờ theo đồng hồ).
    await q(`UPDATE attendance_records SET check_in_at = work_date + interval '2 hours', check_out_at = work_date + interval '10 hours' WHERE check_in_at IS NOT NULL`)
    for (const [p, name] of [
      ['/management/attendance/export', 'hr-attendance-export'],
      ['/management/attendance/absent-export', 'hr-attendance-absent-export'],
      ['/management/attendance/stats/export-by-department', 'hr-attendance-by-department'],
      ['/management/attendance/stats/export-by-gender', 'hr-attendance-by-gender'],
      ['/management/attendance/stats/export-by-team', 'hr-attendance-by-team'],
      ['/management/attendance/stats/export-top-absent', 'hr-attendance-top-absent'],
      ['/management/attendance/stats/export-top-late-early', 'hr-attendance-top-late-early'],
      ['/management/attendance/workdays-matrix/export', 'hr-attendance-workdays-matrix'],
    ] as const) await exportXlsx(p, name)
  })
})
