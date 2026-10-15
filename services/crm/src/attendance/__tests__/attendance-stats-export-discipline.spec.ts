import { AttendanceStatsExportService } from '../attendance-stats-export.service';
import type { AttendanceService, DisciplineStats } from '../attendance.service';

const STATS: DisciplineStats = {
  date_from: '2026-06-01',
  date_to: '2026-06-30',
  work_end: '17:00',
  total_workdays: 22,
  top_absent: [
    {
      user_id: 10,
      full_name: 'Nguyễn Văn A',
      employee_code: 'NV0010',
      team_name: 'Team Alpha',
      position: 'Sale',
      absent_days: 4,
      absent_occurrences: 2,
      absent_rate: 18.2,
    },
  ],
  top_violation: [
    {
      user_id: 10,
      full_name: 'Nguyễn Văn A',
      employee_code: 'NV0010',
      team_name: 'Team Alpha',
      position: 'Sale',
      late_minutes: 60,
      early_minutes: 40,
      violation_minutes: 100,
      late_count: 5,
      early_count: 3,
    },
  ],
  by_gender: [
    {
      gender: 'M',
      gender_label: 'Nam',
      headcount: 10,
      total_absent_days: 12,
      total_late_count: 20,
      total_early_count: 8,
      full_attendance_rate: 85.5,
      insufficient_rate: 14.5,
    },
  ],
};

const makeService = () =>
  new AttendanceStatsExportService({
    getDisciplineStats: jest.fn().mockResolvedValue(STATS),
  } as unknown as AttendanceService);

describe('AttendanceStatsExportService — discipline exports', () => {
  it('exportTopAbsent trả Buffer hợp lệ', async () => {
    const buf = await makeService().exportTopAbsent({});
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('exportTopLateEarly trả Buffer hợp lệ', async () => {
    const buf = await makeService().exportTopLateEarly({});
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('exportByGender trả Buffer hợp lệ', async () => {
    const buf = await makeService().exportByGender({});
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });
});
