import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser, type SeededUser } from '../../lib/db.js'
import { api, call, freshIp } from '../../lib/http.js'
import { config } from '../../lib/config.js'
import { loginSeeded } from '../../lib/session.js'

const made: SeededUser[] = []
const mk = async (o: Parameters<typeof seedUser>[0]) => {
  const u = await seedUser(o)
  made.push(u)
  return u
}

/** Dọn mọi dòng file này seed (phiếu lương, nhân viên, thông báo) để DB dùng chung không dính rác sang ca khác. */
afterAll(async () => {
  const ids = made.map((u) => u.id)
  await q(`DELETE FROM payslips WHERE employee_id IN (SELECT id FROM employees WHERE user_id = ANY($1))`, [ids])
  await q(`DELETE FROM employees WHERE user_id = ANY($1)`, [ids])
  await q(`DELETE FROM notification_logs WHERE recipient_id = ANY($1)`, [ids])
  await closeDb()
})

/**
 * Chuyển từ `apps/monolith/test/rbac/payroll-notification.e2e-spec.ts` (21 ca). Ma trận quyền: duyệt lương 2 bước (đủ/thiếu quyền,
 * ngoài phạm vi, sai trạng thái), phiếu lương own-scope, thông báo mark-read của người khác, secret nội bộ cho `/events/*`.
 */
const o = async (u: SeededUser) => ({ token: (await loginSeeded(u)).token, ip: freshIp() })

async function makeEmployee(userId: number): Promise<number> {
  const [e] = await q<{ id: number }>(`INSERT INTO employees (user_id, position, joined_at) VALUES ($1, 'sales', now()) RETURNING id`, [userId])
  return e.id
}
async function makePayslip(employeeId: number, month: string, status: string, total = 0): Promise<number> {
  const [p] = await q<{ id: number }>(
    `INSERT INTO payslips (employee_id, month, status, total, updated_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [employeeId, month, status, total],
  )
  return p.id
}
async function makeLog(recipientId: number, title: string): Promise<number> {
  const [l] = await q<{ id: number }>(`INSERT INTO notification_logs (recipient_id, channel, title) VALUES ($1, 'in_app', $2) RETURNING id`, [recipientId, title])
  return l.id
}
const approve = async (u: SeededUser, payslipId: number) =>
  api.patch(`/payslips/${payslipId}/approve`, { ...(await o(u)), body: { action: 'approve' } })

describe('Duyệt lương 2 bước: payroll.approve_team / payroll.approve_final', () => {
  it('bước 1: payroll.approve_team scope trùm nhân viên → draft chuyển pending_accountant', async () => {
    const manager = await mk({ label: 'mgr1', grants: { 'payroll.approve_team': 'team' } })
    const staff = await mk({ label: 'staff1', grants: {}, managerId: manager.id })
    const payslip = await makePayslip(await makeEmployee(staff.id), '2026-03', 'draft')
    const res = await approve(manager, payslip)
    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('pending_accountant')
  })

  it('bước 1: nhân viên của phiếu NGOÀI phạm vi payroll.approve_team → 404 (KHÔNG 403)', async () => {
    const manager = await mk({ label: 'mgr2', grants: { 'payroll.approve_team': 'team' } })
    const outsider = await mk({ label: 'outsider2', grants: {} })
    const payslip = await makePayslip(await makeEmployee(outsider.id), '2026-03', 'draft')
    expect((await approve(manager, payslip)).status).toBe(404)
  })

  it('bước 2: có payroll.approve_final → pending_accountant chuyển approved', async () => {
    const accountant = await mk({ label: 'acc3', grants: { 'payroll.approve_final': null } })
    const staff = await mk({ label: 'staff3', grants: {} })
    const payslip = await makePayslip(await makeEmployee(staff.id), '2026-03', 'pending_accountant')
    const res = await approve(accountant, payslip)
    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('approved')
  })

  it('bước 2: THIẾU payroll.approve_final (chỉ giữ approve_team) → 403', async () => {
    const teamLeadOnly = await mk({ label: 'tl4', grants: { 'payroll.approve_team': 'all' } })
    const staff = await mk({ label: 'staff4', grants: {} })
    const payslip = await makePayslip(await makeEmployee(staff.id), '2026-03', 'pending_accountant')
    expect((await approve(teamLeadOnly, payslip)).status).toBe(403)
  })

  it('phiếu đã "approved" (không ở bước chờ duyệt) → 409', async () => {
    const accountant = await mk({ label: 'acc5', grants: { 'payroll.approve_final': null, 'payroll.approve_team': 'all' } })
    const staff = await mk({ label: 'staff5', grants: {} })
    const payslip = await makePayslip(await makeEmployee(staff.id), '2026-03', 'approved')
    expect((await approve(accountant, payslip)).status).toBe(409)
  })

  it('bước 1: employee của phiếu === chính người duyệt (scope own/team luôn chứa self) → 403, KHÔNG tự duyệt được', async () => {
    const manager = await mk({ label: 'mgr6', grants: { 'payroll.approve_team': 'team' } })
    const payslip = await makePayslip(await makeEmployee(manager.id), '2026-03', 'draft')
    expect((await approve(manager, payslip)).status).toBe(403)
  })

  it('bước 2: employee của phiếu === chính người duyệt (approve_final unscoped) → 403, KHÔNG tự duyệt được', async () => {
    const accountant = await mk({ label: 'acc7', grants: { 'payroll.approve_final': null } })
    const payslip = await makePayslip(await makeEmployee(accountant.id), '2026-03', 'pending_accountant')
    expect((await approve(accountant, payslip)).status).toBe(403)
  })

  it('user KHÔNG giữ payroll.approve_team lẫn payroll.approve_final → 403 ngay ở @CanAny route-level', async () => {
    const nobody = await mk({ label: 'nobody8', grants: {} })
    const staff = await mk({ label: 'staff8', grants: {} })
    const payslip = await makePayslip(await makeEmployee(staff.id), '2026-03', 'draft')
    expect((await approve(nobody, payslip)).status).toBe(403)
  })
})

describe('Phiếu lương: payroll.view Mẫu A/B + phiếu của chính mình', () => {
  it('payroll.view scope own → chỉ thấy phiếu của chính mình', async () => {
    const me = await mk({ label: 'me9', grants: { 'payroll.view': 'own' } })
    await makePayslip(await makeEmployee(me.id), '2026-04', 'draft')
    const other = await mk({ label: 'other9', grants: {} })
    await makePayslip(await makeEmployee(other.id), '2026-04', 'draft')
    const res = await api.get('/payslips?month=2026-04', await o(me))
    expect(res.status).toBe(200)
    const rows = res.body as { employee: { user_id: number } }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].employee.user_id).toBe(me.id)
  })

  it('không có payroll.view → 403 khi gọi GET /payslips', async () => {
    const nobody = await mk({ label: 'nobody10', grants: {} })
    expect((await api.get('/payslips?month=2026-04', await o(nobody))).status).toBe(403)
  })

  it('GET /payslips/me — @AuthOnly, KHÔNG cần payroll.view, chỉ thấy phiếu của chính mình', async () => {
    const me = await mk({ label: 'me11', grants: {} })
    await makePayslip(await makeEmployee(me.id), '2026-05', 'draft', 1000)
    const res = await api.get('/payslips/me?month=2026-05', await o(me))
    expect(res.status).toBe(200)
    const rows = res.body as { employee: { user_id: number } }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].employee.user_id).toBe(me.id)
  })

  it('GET /payslips/:id ngoài phạm vi payroll.view → 404', async () => {
    const me = await mk({ label: 'me12', grants: { 'payroll.view': 'own' } })
    const other = await mk({ label: 'other12', grants: {} })
    const payslip = await makePayslip(await makeEmployee(other.id), '2026-04', 'draft')
    expect((await api.get(`/payslips/${payslip}`, await o(me))).status).toBe(404)
  })
})

describe('GET /kpi: chỉ xem KPI của chính mình', () => {
  it('employee_id khớp chính mình → 200 (bất kể có quyền payroll nào)', async () => {
    const me = await mk({ label: 'me13', grants: {} })
    const emp = await makeEmployee(me.id)
    const res = await api.get(`/kpi?employee_id=${emp}&month=2026-03`, await o(me))
    // Không có kpi_result nào → service trả 404 "không có dữ liệu" hoặc 200 rỗng; điều cần khoá: KHÔNG bị RBAC chặn trước business logic.
    expect([200, 404]).toContain(res.status)
  })

  it('employee_id của người khác → 404 (KHÔNG lộ có dữ liệu hay không)', async () => {
    const me = await mk({ label: 'me14', grants: {} })
    const other = await mk({ label: 'other14', grants: {} })
    const emp = await makeEmployee(other.id)
    expect((await api.get(`/kpi?employee_id=${emp}&month=2026-03`, await o(me))).status).toBe(404)
  })
})

describe('Thông báo: @AuthOnly + mark-read của người khác → 404', () => {
  it('đánh dấu thông báo của CHÍNH MÌNH → 200', async () => {
    const me = await mk({ label: 'me15', grants: {} })
    const log = await makeLog(me.id, 'Test')
    expect((await api.patch(`/notifications/${log}/read`, await o(me))).status).toBe(200)
  })

  it('đánh dấu thông báo của NGƯỜI KHÁC → 404 (KHÔNG 403)', async () => {
    const me = await mk({ label: 'me16', grants: {} })
    const other = await mk({ label: 'other16', grants: {} })
    const log = await makeLog(other.id, 'Test')
    expect((await api.patch(`/notifications/${log}/read`, await o(me))).status).toBe(404)
  })

  it('GET /notifications — @AuthOnly, mọi user đăng nhập gọi được', async () => {
    const me = await mk({ label: 'me17', grants: {} })
    expect((await api.get('/notifications', await o(me))).status).toBe(200)
  })

  it('không token → 401', async () => {
    expect((await api.get('/notifications', { ip: freshIp() })).status).toBe(401)
  })
})

describe('/api/v1/events/*: @Internal (INTERNAL_SERVICE_SECRET)', () => {
  it('thiếu x-service-secret → 401', async () => {
    expect((await api.post('/events/payslip-approved', { body: { payload: {} }, ip: freshIp() })).status).toBe(401)
  })

  it('sai x-service-secret → 401', async () => {
    const res = await call('POST', '/api/v1/events/payslip-approved', {
      body: { payload: {} },
      headers: { 'x-service-secret': 'sai-secret-chac-chan-khong-dung' },
      ip: freshIp(),
    })
    expect(res.status).toBe(401)
  })

  it('đúng INTERNAL_SERVICE_SECRET → qua được RBAC, xử lý payload hợp lệ → 200', async () => {
    // User thật: onPayslipApproved ghi notification_logs có khoá ngoại theo userId.
    const recipient = await mk({ label: 'recipient', grants: {} })
    const res = await call('POST', '/api/v1/events/payslip-approved', {
      headers: { 'x-service-secret': config.serviceSecret },
      ip: freshIp(),
      body: {
        event: 'payslip.approved',
        timestamp: new Date().toISOString(),
        payload: {
          payslipId: 1,
          employeeId: 1,
          userId: recipient.id,
          month: '2026-01',
          baseSalary: 1000,
          kpiBonus: 0,
          totalAmount: 1000,
          approvedBy: recipient.id,
          approvedAt: new Date().toISOString(),
        },
      },
    })
    expect(res.status).toBe(200)
  })
})
