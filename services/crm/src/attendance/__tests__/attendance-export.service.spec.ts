import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '@trinity/prisma';
import { AttendanceExportService } from '../attendance-export.service';
import { AttendanceService } from '../attendance.service';

const makePrisma = () =>
  ({
    attendanceRecord: { findMany: jest.fn() },
    // exportToExcel gọi loadTeamOrgLookup() → prisma.team.findMany.
    team: { findMany: jest.fn().mockResolvedValue([]) },
  }) as unknown as PrismaService;

// Mock AttendanceService — export service chỉ gọi getShiftConfig() để recompute total_hours/status.
const makeAttendanceService = () =>
  ({
    getShiftConfig: jest.fn().mockResolvedValue({
      work_start: '08:00',
      work_end: '17:00',
      late_after: '08:10',
      lunch_start: '11:30',
      lunch_end: '13:30',
      review_max_hours: 1,
      half_day_min_hours: 4,
      full_day_min_hours: 8,
    }),
  }) as unknown as AttendanceService;

const sampleRow = {
  id: 1,
  user_id: 42,
  work_date: new Date('2026-06-16T00:00:00Z'),
  check_in_at: new Date('2026-06-16T01:05:00Z'), // 08:05 VN
  check_out_at: new Date('2026-06-16T10:30:00Z'), // 17:30 VN
  check_in_note: 'Đi làm bình thường',
  check_out_note: null,
  total_hours: 8.5,
  late_minutes: 0,
  status: 'present',
  user: {
    full_name: 'Nguyễn Văn A',
    email: 'a@example.com',
    employee: { position: 'Nhân viên kinh doanh' },
  },
};

describe('AttendanceExportService', () => {
  let service: AttendanceExportService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceExportService,
        { provide: PrismaService, useValue: prisma },
        { provide: AttendanceService, useValue: makeAttendanceService() },
      ],
    }).compile();
    service = module.get(AttendanceExportService);
  });

  it('returns a non-empty xlsx Buffer', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([sampleRow]);

    const buf = await service.exportToExcel(
      { date_from: '2026-06-16', date_to: '2026-06-16' },
      'all',
    );

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    // xlsx is a zip → starts with "PK"
    expect(buf.slice(0, 2).toString('latin1')).toBe('PK');
  });

  it('applies date_from/date_to/user_id to the query where clause', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([]);

    await service.exportToExcel(
      { date_from: '2026-06-01', date_to: '2026-06-30', user_id: 42 },
      'all',
    );

    const arg = (prisma.attendanceRecord.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.user_id).toBe(42);
    expect(arg.where.work_date.gte).toEqual(new Date(Date.UTC(2026, 5, 1)));
    expect(arg.where.work_date.lte).toEqual(new Date(Date.UTC(2026, 5, 30)));
    expect(arg.take).toBeGreaterThan(0);
  });

  it('handles empty result set without throwing', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([]);
    const buf = await service.exportToExcel({}, 'all');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('total_hours + status trong Excel TÍNH LẠI từ giờ chấm (trừ nghỉ trưa), KHÔNG dùng giá trị lưu DB', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([sampleRow]);
    const buf = await service.exportToExcel(
      { date_from: '2026-06-16', date_to: '2026-06-16' },
      'all',
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('Chấm công');
    expect(sheet).toBeDefined();
    const dataRow = sheet!.getRow(4); // hàng 1–3 = tiêu đề/khoảng/header cột
    // sampleRow: vào 08:05, ra 17:30 → 9h25m gộp − 2h nghỉ trưa (11:30–13:30) = 7.42h
    // (KHÔNG phải 8.5 lưu DB — đó là giá trị stale chưa trừ nghỉ trưa).
    // Cột (thêm Team/Phòng ban sau Họ tên): 1 Họ tên, 2 Team, 3 Phòng ban, 4 Email,
    // 5 Chức danh, 6 Ngày, 7 Giờ vào, 8 Giờ ra, 9 Tổng giờ, 10 Đi muộn, 11 Trạng thái, ...
    expect(dataRow.getCell(9).value).toBe(7.42);
    // 7.42h < 8h (full_day_min) → "Nửa ngày" (KHÔNG phải "Đủ công" từ status='present' lưu DB).
    expect(dataRow.getCell(11).value).toBe('Nửa ngày');
  });

  it("scope team [42, 43] → where.user_id giao (IN) đúng team, KHÔNG toàn bộ NV", async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([]);
    await service.exportToExcel({ date_from: '2026-06-16', date_to: '2026-06-16' }, [42, 43]);
    const arg = (prisma.attendanceRecord.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.user_id).toEqual({ in: [42, 43] });
  });

  it('scope team [42, 43] + dto.user_id=99 (ngoài team) → giao rỗng (-1), KHÔNG lộ dữ liệu ngoài scope', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([]);
    await service.exportToExcel({ user_id: 99 }, [42, 43]);
    const arg = (prisma.attendanceRecord.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.user_id).toBe(-1);
  });
});
