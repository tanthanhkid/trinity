import { Test, TestingModule } from '@nestjs/testing';
import { AttendanceAbsentExportService } from '../attendance-absent-export.service';
import { AttendanceService, type AbsentEmployee } from '../attendance.service';

const SAMPLE: AbsentEmployee[] = [
  { user_id: 1, employee_code: 'NV0001', full_name: 'Nguyễn A', email: 'a@x.vn', phone: '0900000001', position: 'Sale', department: 'KD', gender: 'M', office_name: 'VP HN', team_name: 'Team A', team_id: 10 },
  { user_id: 2, employee_code: 'NV0002', full_name: 'Trần B', email: null, phone: null, position: null, department: null, gender: 'F', office_name: null, team_name: 'Team A', team_id: 10 },
  { user_id: 3, employee_code: 'NV0003', full_name: 'Lê C', email: null, phone: null, position: null, department: null, gender: null, office_name: null, team_name: null, team_id: null },
];

async function buildService(rows: AbsentEmployee[]) {
  const getAbsentEmployees = jest.fn().mockResolvedValue(rows);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AttendanceAbsentExportService,
      { provide: AttendanceService, useValue: { getAbsentEmployees } },
    ],
  }).compile();
  return { service: module.get(AttendanceAbsentExportService), getAbsentEmployees };
}

describe('AttendanceAbsentExportService', () => {
  it('xuất Buffer xlsx không rỗng + forward đúng ngày & sort cho getAbsentEmployees', async () => {
    const { service, getAbsentEmployees } = await buildService(SAMPLE);

    const buf = await service.exportAbsentToExcel('2026-06-20', 'full_name', 'desc');

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    // Sort forward nguyên vẹn → Excel khớp đúng sort đang xem trên bảng (scope undefined = không lọc).
    expect(getAbsentEmployees).toHaveBeenCalledWith('2026-06-20', 'full_name', 'desc', undefined);
  });

  it('danh sách rỗng vẫn xuất file (chỉ header)', async () => {
    const { service } = await buildService([]);
    const buf = await service.exportAbsentToExcel('2026-06-20');
    expect(buf.length).toBeGreaterThan(0);
  });
});
