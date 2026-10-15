import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '@trinity/prisma';
import { bootApp, resetDb, makeUser, api } from './harness';

/**
 * Ma trận E2E quyền cho cụm crm nhân sự/tổ chức/chấm công: employees, contracts, recruitment, attendance, teams,
 * job-titles, departments (settings). Mỗi controller có tối thiểu 1 ca 403,
 * 1 ca scope hẹp, 1 ca 404 theo id, và ca export/config nếu có .
 */
describe('RBAC E2E — cụm CRM nhân sự/tổ chức/chấm công', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ app, prisma, close } = await bootApp());
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  /**
   * Dọn dữ liệu nghiệp vụ TRƯỚC khi `resetDb` xoá user — `employees` KHÔNG
   * `onDelete: Cascade` trên `user_id` nên xoá user còn Employee liên kết sẽ
   * vỡ FK. `attendance_records` có `onDelete: Cascade` trên `user_id` nên tự
   * dọn khi xoá user — không cần đụng tay.
   */
  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM employee_contracts WHERE employee_id IN (SELECT id FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test'))`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM recruitment_candidates`);
    await prisma.$executeRawUnsafe(`DELETE FROM teams`);
    await prisma.$executeRawUnsafe(`DELETE FROM job_titles`);
    await resetDb(prisma);
  });

  // ─── employees.view Mẫu A + employees.manage + employees.export + ─────

  describe('GET/PATCH /management/employees', () => {
    it('không có quyền employees.view → 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/management/employees').expect(403);
    });

    it("scope 'own' → chỉ thấy hồ sơ nhân viên của chính mình, KHÔNG thấy người khác", async () => {
      const self = await makeUser(prisma, { grants: { 'employees.view': 'own' } });
      const other = await makeUser(prisma, {});
      await prisma.employee.create({
        data: { user_id: self.id, position: 'NV', status: 'active' },
      });
      await prisma.employee.create({
        data: { user_id: other.id, position: 'NV', status: 'active' },
      });

      const res = await api(app, self.token)
        .get('/api/v1/management/employees')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].user_id).toBe(self.id);
    });

    it('theo id ngoài phạm vi → 404 (không 403)', async () => {
      const self = await makeUser(prisma, { grants: { 'employees.view': 'own' } });
      const other = await makeUser(prisma, {});
      const otherEmp = await prisma.employee.create({
        data: { user_id: other.id, position: 'NV', status: 'active' },
      });

      await api(app, self.token)
        .get(`/api/v1/management/employees/${otherEmp.id}`)
        .expect(404);
    });

    it('không có quyền employees.manage → tạo nhân viên bị 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token)
        .post('/api/v1/management/employees')
        .send({ email: `new-${Date.now()}@rbac-e2e.test`, full_name: 'NV Mới' })
        .expect(403);
    });

    it('có quyền employees.manage → tạo nhân viên thành công (201)', async () => {
      const u = await makeUser(prisma, { grants: { 'employees.manage': true } });
      const res = await api(app, u.token)
        .post('/api/v1/management/employees')
        .send({ email: `new-${Date.now()}@rbac-e2e.test`, full_name: 'NV Mới' })
        .expect(201);
      expect(res.body.full_name).toBe('NV Mới');
    });

    it('không có quyền employees.export → xuất Excel bị 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/management/employees/export').expect(403);
    });

    it('có employees.manage nhưng users.manage KHÔNG phủ target → PATCH 404 (chạm tài khoản liên kết)', async () => {
      const caller = await makeUser(prisma, {
        grants: { 'employees.manage': true, 'users.manage': 'own' },
      });
      const target = await makeUser(prisma, {});
      const targetEmp = await prisma.employee.create({
        data: { user_id: target.id, position: 'NV', status: 'active' },
      });

      await api(app, caller.token)
        .patch(`/api/v1/management/employees/${targetEmp.id}`)
        .send({ full_name: 'Đổi tên' })
        .expect(404);
    });
  });

  // ─── attendance.view Mẫu A + attendance.config + AuthOnly "của tôi" ───────

  describe('GET/PATCH /management/attendance', () => {
    it('không có quyền attendance.view → 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/management/attendance').expect(403);
    });

    it("scope 'own' → chỉ thấy bản ghi chấm công của chính mình", async () => {
      const self = await makeUser(prisma, { grants: { 'attendance.view': 'own' } });
      const other = await makeUser(prisma, {});
      const today = new Date().toISOString().slice(0, 10);
      await prisma.attendanceRecord.create({
        data: { user_id: self.id, work_date: new Date(today) },
      });
      await prisma.attendanceRecord.create({
        data: { user_id: other.id, work_date: new Date(today) },
      });

      const res = await api(app, self.token)
        .get('/api/v1/management/attendance')
        .expect(200);

      const rows = res.body.data ?? res.body;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.every((r: { user_id: number }) => r.user_id === self.id)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('theo id ngoài phạm vi → 404 (không 403)', async () => {
      const self = await makeUser(prisma, { grants: { 'attendance.view': 'own' } });
      const other = await makeUser(prisma, {});
      const rec = await prisma.attendanceRecord.create({
        data: { user_id: other.id, work_date: new Date() },
      });

      await api(app, self.token)
        .get(`/api/v1/management/attendance/${rec.id}`)
        .expect(404);
    });

    it('GET settings — AuthOnly, mọi người đã đăng nhập đọc được (mẫu chính thức "của tôi")', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/management/attendance/settings').expect(200);
    });

    it('không có quyền attendance.config → sửa cấu hình ca làm bị 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token)
        .patch('/api/v1/management/attendance/settings')
        .send({ work_start: '08:30' })
        .expect(403);
    });
  });

  // ─── contracts.view / contracts.manage ─────────────────────────────────────

  describe('GET/POST /management/contracts', () => {
    it('không có quyền contracts.view → 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/management/contracts').expect(403);
    });

    it('có quyền contracts.view → 200', async () => {
      const u = await makeUser(prisma, { grants: { 'contracts.view': 'all' } });
      await api(app, u.token).get('/api/v1/management/contracts').expect(200);
    });

    it('không có quyền contracts.manage → thêm hợp đồng bị 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token)
        .post('/api/v1/management/contracts')
        .send({ employee_id: 1, signed_date: '2026-01-01' })
        .expect(403);
    });

    it('có quyền contracts.manage → thêm hợp đồng thành công (201)', async () => {
      const u = await makeUser(prisma, { grants: { 'contracts.manage': true } });
      const emp = await prisma.employee.create({
        data: { user_id: u.id, position: 'NV', status: 'active' },
      });

      await api(app, u.token)
        .post('/api/v1/management/contracts')
        .send({ employee_id: emp.id, signed_date: '2026-01-01' })
        .expect(201);
    });
  });

  // ─── recruitment.view / recruitment.manage ─────────────────────────────────

  describe('GET /management/recruitment/candidates', () => {
    it('không có quyền recruitment.view → 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/management/recruitment/candidates').expect(403);
    });

    it('có quyền recruitment.view → 200', async () => {
      const u = await makeUser(prisma, { grants: { 'recruitment.view': true } });
      await api(app, u.token).get('/api/v1/management/recruitment/candidates').expect(200);
    });

    it('không có quyền recruitment.manage → thêm ứng viên bị 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token)
        .post('/api/v1/management/recruitment/candidates')
        .send({ full_name: 'Ứng viên A' })
        .expect(403);
    });
  });

  // ─── org.manage (team/job-title/department) + đọc mở AuthOnly ─────────────

  describe('GET/POST /management/teams', () => {
    it('không có quyền org.manage → 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/management/teams').expect(403);
    });

    it('có quyền org.manage → 200', async () => {
      const u = await makeUser(prisma, { grants: { 'org.manage': true } });
      await api(app, u.token).get('/api/v1/management/teams').expect(200);
    });

    it('for-filter — AuthOnly, mọi người đã đăng nhập dùng được dropdown', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/management/teams/for-filter').expect(200);
    });

    it('không có quyền org.manage → tạo team bị 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token)
        .post('/api/v1/management/teams')
        .send({ name: `Team ${Date.now()}` })
        .expect(403);
    });
  });

  describe('GET/POST /management/job-titles', () => {
    it('GET — AuthOnly, mọi người đã đăng nhập đọc được danh mục chức danh', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/management/job-titles').expect(200);
    });

    it('không có quyền org.manage → tạo chức danh bị 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token)
        .post('/api/v1/management/job-titles')
        .send({
          category: 'Nhân viên',
          rank_code: `RC${Date.now()}`,
          name: 'Chuyên viên',
          symbol: 'CV',
          review_cycle_months: 6,
        })
        .expect(403);
    });

    it('có quyền org.manage → tạo chức danh thành công (201)', async () => {
      const u = await makeUser(prisma, { grants: { 'org.manage': true } });
      await api(app, u.token)
        .post('/api/v1/management/job-titles')
        .send({
          category: 'Nhân viên',
          rank_code: `RC${Date.now()}`,
          name: 'Chuyên viên',
          symbol: 'CV',
          review_cycle_months: 6,
        })
        .expect(201);
    });
  });

  describe('GET/PATCH /settings/departments', () => {
    it('GET — AuthOnly, mọi người đã đăng nhập đọc được (dropdown dùng chung)', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token).get('/api/v1/settings/departments').expect(200);
    });

    it('không có quyền org.manage → sửa danh sách phòng ban bị 403', async () => {
      const u = await makeUser(prisma, { grants: {} });
      await api(app, u.token)
        .patch('/api/v1/settings/departments')
        .send({ departments: ['Kinh doanh', 'Kế toán'] })
        .expect(403);
    });

    it('có quyền org.manage → sửa danh sách phòng ban thành công (200)', async () => {
      const u = await makeUser(prisma, { grants: { 'org.manage': true } });
      await api(app, u.token)
        .patch('/api/v1/settings/departments')
        .send({ departments: ['Kinh doanh', 'Kế toán'] })
        .expect(200);
    });
  });
});
