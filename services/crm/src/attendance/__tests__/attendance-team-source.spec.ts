import { AttendanceService } from '../attendance.service';
import { PrismaService } from '@trinity/prisma';
import { StorageService } from '../../storage/storage.service';
import { NotificationsService } from '../../notifications/notifications.service';
import type { ScopeService } from '@trinity/rbac-nest';

/**
 * Regression guard — chuẩn hóa Team chấm công sang bảng `teams` CHÍNH THỨC (Cài đặt → Team),
 * không lấy từ `users.manager_id` (sơ đồ tổ chức). Mock `$queryRaw` capture tagged-template
 * args → flatten thành text → assert marker SQL (KHÔNG so dữ liệu thật).
 */

/** Flatten 1 lời gọi $queryRaw (tagged template) thành text tìm marker — gồm cả Prisma.Sql lồng. */
function sqlText(call: unknown[]): string {
  const [strings, ...values] = call as [unknown, ...unknown[]];
  const lit = Array.isArray(strings)
    ? (strings as string[]).join(' ')
    : String(strings);
  const vals = values
    .map((v) => {
      if (v && typeof v === 'object') {
        const sv = v as { sql?: string; strings?: string[] };
        if (typeof sv.sql === 'string') return sv.sql;
        if (Array.isArray(sv.strings)) return sv.strings.join(' ');
        return '';
      }
      return String(v);
    })
    .join(' ');
  return `${lit} ${vals}`;
}

const makePrisma = (queryRaw: jest.Mock) =>
  ({ $queryRaw: queryRaw }) as unknown as PrismaService;

const makeService = (queryRaw: jest.Mock) =>
  new AttendanceService(
    makePrisma(queryRaw),
    {} as unknown as StorageService,
    {} as unknown as NotificationsService,
    {} as unknown as ScopeService,
  );

const DTO = { date_from: '2026-06-01', date_to: '2026-06-30' };

describe('AttendanceService — Team CHÍNH THỨC (bảng teams)', () => {
  describe('getStatsByTeam', () => {
    it('group theo team chính thức (teams + resolve 3 tầng), KHÔNG còn u.manager_id', async () => {
      const qr = jest.fn().mockResolvedValue([]);
      await makeService(qr).getStatsByTeam(DTO);
      const sql = sqlText(qr.mock.calls[0]);
      expect(sql).toContain('LEFT JOIN teams t ON t.id = resolved.team_id');
      expect(sql).toContain('CROSS JOIN LATERAL');
      expect(sql).toContain('team_lead_id'); // resolve 3 tầng
      expect(sql).toContain('GROUP BY resolved.team_id');
      // KHÔNG còn dùng quản lý trực tiếp làm "Team"
      expect(sql).not.toContain('u.manager_id::int AS team_id');
      expect(sql).not.toContain("COALESCE(mgr.full_name, 'Chưa có quản lý')");
    });
  });

  describe('buildStatsEmpFilter (qua getStatsByTeam) — lọc theo team.id chính thức', () => {
    it('team_id thường → resolve 3 tầng IN (...)', async () => {
      const qr = jest.fn().mockResolvedValue([]);
      await makeService(qr).getStatsByTeam({ ...DTO, team_id: [5, 7] });
      const sql = sqlText(qr.mock.calls[0]);
      expect(sql).toContain('e.team_id'); // tầng 1 của resolve
      expect(sql).toContain('IN');
      expect(sql).not.toContain('u.manager_id IN'); // KHÔNG còn lọc theo manager
    });

    it('sentinel -1 ("Chưa có team") → IS NULL', async () => {
      const qr = jest.fn().mockResolvedValue([]);
      await makeService(qr).getStatsByTeam({ ...DTO, team_id: [-1] });
      const sql = sqlText(qr.mock.calls[0]);
      expect(sql).toContain('IS NULL');
    });
  });

  describe('getStatsFilterOptions', () => {
    it('admin (scope null) → TẤT CẢ team từ bảng teams + option "Chưa có team"', async () => {
      const qr = jest.fn().mockResolvedValue([]);
      const res = await makeService(qr).getStatsFilterOptions(null);
      const allSql = qr.mock.calls.map(sqlText).join('\n');
      // có query lấy toàn bộ team (không scope)
      expect(allSql).toContain('SELECT id::int AS id, name FROM teams ORDER BY name ASC');
      // KHÔNG còn build team từ manager_id
      expect(allSql).not.toContain('u.manager_id::int AS id');
      // sentinel "Chưa có team" luôn được append
      expect(res.teams).toContainEqual({ id: -1, name: 'Chưa có team' });
    });

    it('team_lead (có scope) → chỉ team có NV trong scope (JOIN teams + resolve)', async () => {
      const qr = jest.fn().mockResolvedValue([]);
      await makeService(qr).getStatsFilterOptions([10, 11]);
      const allSql = qr.mock.calls.map(sqlText).join('\n');
      expect(allSql).toContain('JOIN teams t ON t.id =');
      expect(allSql).toContain('team_lead_id');
      expect(allSql).toContain('e.user_id IN'); // scope subtree
    });
  });

  describe('getEmployeeAttendanceSummary (Sheet 2 chi tiết NV)', () => {
    it('roster-based per-NV, team resolve 3 tầng, presence-based (đủ/thiếu công + nghỉ phép)', async () => {
      const qr = jest.fn().mockResolvedValue([]);
      await makeService(qr).getEmployeeAttendanceSummary(DTO);
      const sql = sqlText(qr.mock.calls[0]);
      expect(sql).toContain('LEFT JOIN teams t ON t.id = resolved.team_id');
      expect(sql).toContain('AS full_days');
      expect(sql).toContain('AS insufficient_days');
      expect(sql).toContain('AS leave_days');
      expect(sql).toContain('employee_code');
    });
  });
});
