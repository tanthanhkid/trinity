import { AttendanceStatsExportService } from '../attendance-stats-export.service';
import type {
  AttendanceService,
  TeamStatRow,
  DepartmentStatRow,
} from '../attendance.service';

const teamRow: TeamStatRow = {
  team_id: 1,
  team_name: 'Team A',
  headcount: 10,
  checked_in_people: 8,
  present_people: 6,
  late_people: 2,
  insufficient_people: 2,
  absent_people: 2,
  attendance_rate: 80,
  total_late_minutes: 30,
};

const deptRow: DepartmentStatRow = {
  department: 'Kinh doanh',
  head_name: 'Trưởng Phòng KD',
  headcount: 6,
  checked_in_people: 6,
  present_people: 6,
  late_people: 0,
  insufficient_people: 0,
  absent_people: 0,
  attendance_rate: 100,
  total_late_minutes: 0,
};

describe('AttendanceStatsExportService', () => {
  it('exportByTeam trả Buffer xlsx + gọi getStatsByTeam với dto', async () => {
    const attendance = {
      getStatsByTeam: jest.fn().mockResolvedValue([teamRow]),
      getStatsByDepartment: jest.fn(),
      getEmployeeAttendanceSummary: jest.fn().mockResolvedValue([]),
    } as unknown as AttendanceService;
    const service = new AttendanceStatsExportService(attendance);

    const dto = { date_from: '2026-06-01', date_to: '2026-06-23' };
    const buf = await service.exportByTeam(dto);

    expect(attendance.getStatsByTeam).toHaveBeenCalledWith(dto, undefined);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('exportByDepartment trả Buffer xlsx + gọi getStatsByDepartment với dto', async () => {
    const attendance = {
      getStatsByTeam: jest.fn(),
      getStatsByDepartment: jest.fn().mockResolvedValue([deptRow]),
      getEmployeeAttendanceSummary: jest.fn().mockResolvedValue([]),
    } as unknown as AttendanceService;
    const service = new AttendanceStatsExportService(attendance);

    const dto = {};
    const buf = await service.exportByDepartment(dto);

    expect(attendance.getStatsByDepartment).toHaveBeenCalledWith(dto, undefined);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('xuất được khi danh sách rỗng (không lỗi)', async () => {
    const attendance = {
      getStatsByTeam: jest.fn().mockResolvedValue([]),
      getStatsByDepartment: jest.fn(),
      getEmployeeAttendanceSummary: jest.fn().mockResolvedValue([]),
    } as unknown as AttendanceService;
    const service = new AttendanceStatsExportService(attendance);

    const buf = await service.exportByTeam({});
    expect(Buffer.isBuffer(buf)).toBe(true);
  });
});
