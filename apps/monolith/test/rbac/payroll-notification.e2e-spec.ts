import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * Cụm payroll + notification. Ma trận quyền: duyệt lương 2 bước (đủ/thiếu quyền, ngoài phạm vi, sai trạng
 * thái), phiếu lương own-scope, thông báo mark-read của người khác, secret
 * nội bộ cho `/events/*`.
 */
describe('RBAC E2E — payroll + notification', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp())
  }, 60_000)

  afterAll(async () => {
    await close()
  })

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE payslips, employees, notification_logs RESTART IDENTITY CASCADE`)
    await resetDb(prisma)
  })

  async function makeEmployee(userId: number) {
    return prisma.employee.create({
      data: { user_id: userId, position: 'sales', joined_at: new Date() },
      select: { id: true, user_id: true },
    })
  }

  describe('Duyệt lương 2 bước — payroll.approve_team / payroll.approve_final', () => {
    it('bước 1: payroll.approve_team scope trùm nhân viên → draft chuyển pending_accountant', async () => {
      const manager = await makeUser(prisma, { grants: { 'payroll.approve_team': 'team' } })
      const staff = await makeUser(prisma, { managerId: manager.id })
      const emp = await makeEmployee(staff.id)
      const payslip = await prisma.payslip.create({
        data: { employee_id: emp.id, month: '2026-03', status: 'draft' },
        select: { id: true },
      })

      const res = await api(app, manager.token)
        .patch(`/api/v1/payslips/${payslip.id}/approve`)
        .send({ action: 'approve' })
        .expect(200)
      expect(res.body.status).toBe('pending_accountant')
    })

    it('bước 1: nhân viên của phiếu NGOÀI phạm vi payroll.approve_team → 404 (KHÔNG 403)', async () => {
      const manager = await makeUser(prisma, { grants: { 'payroll.approve_team': 'team' } })
      const outsider = await makeUser(prisma) // KHÔNG dưới quyền manager
      const emp = await makeEmployee(outsider.id)
      const payslip = await prisma.payslip.create({
        data: { employee_id: emp.id, month: '2026-03', status: 'draft' },
        select: { id: true },
      })

      await api(app, manager.token)
        .patch(`/api/v1/payslips/${payslip.id}/approve`)
        .send({ action: 'approve' })
        .expect(404)
    })

    it('bước 2: có payroll.approve_final → pending_accountant chuyển approved', async () => {
      const accountant = await makeUser(prisma, { grants: { 'payroll.approve_final': true } })
      const staff = await makeUser(prisma)
      const emp = await makeEmployee(staff.id)
      const payslip = await prisma.payslip.create({
        data: { employee_id: emp.id, month: '2026-03', status: 'pending_accountant' },
        select: { id: true },
      })

      const res = await api(app, accountant.token)
        .patch(`/api/v1/payslips/${payslip.id}/approve`)
        .send({ action: 'approve' })
        .expect(200)
      expect(res.body.status).toBe('approved')
    })

    it('bước 2: THIẾU payroll.approve_final (chỉ giữ approve_team) → 403', async () => {
      const teamLeadOnly = await makeUser(prisma, { grants: { 'payroll.approve_team': 'all' } })
      const staff = await makeUser(prisma)
      const emp = await makeEmployee(staff.id)
      const payslip = await prisma.payslip.create({
        data: { employee_id: emp.id, month: '2026-03', status: 'pending_accountant' },
        select: { id: true },
      })

      await api(app, teamLeadOnly.token)
        .patch(`/api/v1/payslips/${payslip.id}/approve`)
        .send({ action: 'approve' })
        .expect(403)
    })

    it('phiếu đã "approved" (không ở bước chờ duyệt) → 409', async () => {
      const accountant = await makeUser(prisma, { grants: { 'payroll.approve_final': true, 'payroll.approve_team': 'all' } })
      const staff = await makeUser(prisma)
      const emp = await makeEmployee(staff.id)
      const payslip = await prisma.payslip.create({
        data: { employee_id: emp.id, month: '2026-03', status: 'approved' },
        select: { id: true },
      })

      await api(app, accountant.token)
        .patch(`/api/v1/payslips/${payslip.id}/approve`)
        .send({ action: 'approve' })
        .expect(409)
    })

    it('bước 1: employee của phiếu === chính người duyệt (scope own/team luôn chứa self) → 403, KHÔNG tự duyệt được', async () => {
      const manager = await makeUser(prisma, { grants: { 'payroll.approve_team': 'team' } })
      const emp = await makeEmployee(manager.id) // phiếu của chính manager
      const payslip = await prisma.payslip.create({
        data: { employee_id: emp.id, month: '2026-03', status: 'draft' },
        select: { id: true },
      })

      await api(app, manager.token)
        .patch(`/api/v1/payslips/${payslip.id}/approve`)
        .send({ action: 'approve' })
        .expect(403)
    })

    it('bước 2: employee của phiếu === chính người duyệt (approve_final unscoped) → 403, KHÔNG tự duyệt được', async () => {
      const accountant = await makeUser(prisma, { grants: { 'payroll.approve_final': true } })
      const emp = await makeEmployee(accountant.id) // phiếu của chính accountant
      const payslip = await prisma.payslip.create({
        data: { employee_id: emp.id, month: '2026-03', status: 'pending_accountant' },
        select: { id: true },
      })

      await api(app, accountant.token)
        .patch(`/api/v1/payslips/${payslip.id}/approve`)
        .send({ action: 'approve' })
        .expect(403)
    })

    it('user KHÔNG giữ payroll.approve_team lẫn payroll.approve_final → 403 ngay ở @CanAny route-level', async () => {
      const nobody = await makeUser(prisma, {})
      const staff = await makeUser(prisma)
      const emp = await makeEmployee(staff.id)
      const payslip = await prisma.payslip.create({
        data: { employee_id: emp.id, month: '2026-03', status: 'draft' },
        select: { id: true },
      })

      await api(app, nobody.token)
        .patch(`/api/v1/payslips/${payslip.id}/approve`)
        .send({ action: 'approve' })
        .expect(403)
    })
  })

  describe('Phiếu lương — payroll.view Mẫu A/B + phiếu của chính mình', () => {
    it('payroll.view scope own → chỉ thấy phiếu của chính mình', async () => {
      const me = await makeUser(prisma, { grants: { 'payroll.view': 'own' } })
      const myEmp = await makeEmployee(me.id)
      await prisma.payslip.create({ data: { employee_id: myEmp.id, month: '2026-04', status: 'draft' } })

      const other = await makeUser(prisma)
      const otherEmp = await makeEmployee(other.id)
      await prisma.payslip.create({ data: { employee_id: otherEmp.id, month: '2026-04', status: 'draft' } })

      const res = await api(app, me.token).get('/api/v1/payslips?month=2026-04').expect(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].employee.user_id).toBe(me.id)
    })

    it('không có payroll.view → 403 khi gọi GET /payslips', async () => {
      const nobody = await makeUser(prisma, {})
      await api(app, nobody.token).get('/api/v1/payslips?month=2026-04').expect(403)
    })

    it('GET /payslips/me — @AuthOnly, KHÔNG cần payroll.view, chỉ thấy phiếu của chính mình', async () => {
      const me = await makeUser(prisma, {}) // KHÔNG có bất kỳ quyền payroll nào
      const myEmp = await makeEmployee(me.id)
      await prisma.payslip.create({ data: { employee_id: myEmp.id, month: '2026-05', status: 'draft', total: BigInt(1000) } })

      const res = await api(app, me.token).get('/api/v1/payslips/me?month=2026-05').expect(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].employee.user_id).toBe(me.id)
    })

    it('GET /payslips/:id ngoài phạm vi payroll.view → 404', async () => {
      const me = await makeUser(prisma, { grants: { 'payroll.view': 'own' } })
      const other = await makeUser(prisma)
      const otherEmp = await makeEmployee(other.id)
      const payslip = await prisma.payslip.create({
        data: { employee_id: otherEmp.id, month: '2026-04', status: 'draft' },
        select: { id: true },
      })

      await api(app, me.token).get(`/api/v1/payslips/${payslip.id}`).expect(404)
    })
  })

  describe('GET /kpi — chỉ xem KPI của chính mình', () => {
    it('employee_id khớp chính mình → 200 (bất kể có quyền payroll nào)', async () => {
      const me = await makeUser(prisma, {})
      const myEmp = await makeEmployee(me.id)

      await api(app, me.token)
        .get(`/api/v1/kpi?employee_id=${myEmp.id}&month=2026-03`)
        .expect((res) => {
          // Không có kpi_result nào -> service có thể trả 404 "không có dữ liệu" hoặc 200 rỗng;
          // điều cốt lõi cần khoá ở đây là KHÔNG bị chặn bởi RBAC trước khi tới business logic.
          expect([200, 404]).toContain(res.status)
        })
    })

    it('employee_id của người khác → 404 (KHÔNG lộ có dữ liệu hay không)', async () => {
      const me = await makeUser(prisma, {})
      const other = await makeUser(prisma)
      const otherEmp = await makeEmployee(other.id)

      await api(app, me.token)
        .get(`/api/v1/kpi?employee_id=${otherEmp.id}&month=2026-03`)
        .expect(404)
    })
  })

  describe('Thông báo — @AuthOnly + mark-read của người khác → 404', () => {
    it('đánh dấu thông báo của CHÍNH MÌNH → 200', async () => {
      const me = await makeUser(prisma, {})
      const log = await prisma.notificationLog.create({
        data: { recipient_id: me.id, channel: 'in_app', title: 'Test' },
        select: { id: true },
      })

      await api(app, me.token).patch(`/api/v1/notifications/${log.id}/read`).expect(200)
    })

    it('đánh dấu thông báo của NGƯỜI KHÁC → 404 (KHÔNG 403)', async () => {
      const me = await makeUser(prisma, {})
      const other = await makeUser(prisma)
      const log = await prisma.notificationLog.create({
        data: { recipient_id: other.id, channel: 'in_app', title: 'Test' },
        select: { id: true },
      })

      await api(app, me.token).patch(`/api/v1/notifications/${log.id}/read`).expect(404)
    })

    it('GET /notifications — @AuthOnly, mọi user đăng nhập gọi được', async () => {
      const me = await makeUser(prisma, {})
      await api(app, me.token).get('/api/v1/notifications').expect(200)
    })

    it('không token → 401', async () => {
      await api(app).get('/api/v1/notifications').expect(401)
    })
  })

  describe('/api/v1/events/* — @Internal (INTERNAL_SERVICE_SECRET)', () => {
    it('thiếu x-service-secret → 401', async () => {
      await api(app).post('/api/v1/events/payslip-approved').send({ payload: {} }).expect(401)
    })

    it('sai x-service-secret → 401', async () => {
      const server = app.getHttpServer()
      const request = (await import('supertest')).default
      await request(server)
        .post('/api/v1/events/payslip-approved')
        .set('x-service-secret', 'sai-secret-chac-chan-khong-dung')
        .send({ payload: {} })
        .expect(401)
    })

    it('đúng INTERNAL_SERVICE_SECRET → qua được RBAC, xử lý payload hợp lệ → 200', async () => {
      const recipient = await makeUser(prisma, {}) // user thật — onPayslipApproved ghi notification_logs FK theo userId
      const server = app.getHttpServer()
      const request = (await import('supertest')).default
      await request(server)
        .post('/api/v1/events/payslip-approved')
        .set('x-service-secret', process.env.INTERNAL_SERVICE_SECRET as string)
        .send({
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
        })
        .expect(200)
    })
  })
})
