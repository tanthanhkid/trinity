import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import type { AuthUser } from '@trinity/rbac-nest';
import { EmployeesService } from './employees.service';
import { BirthdayListQueryDto } from './dto/employees-stats.dto';

type BirthdayItem = Awaited<
  ReturnType<EmployeesService['getBirthdayList']>
>['items'][number];

interface ColumnDef {
  header: string;
  key: string;
  numeric?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { header: 'STT', key: 'stt', numeric: true },
  { header: 'Mã NV', key: 'employee_code' },
  { header: 'Họ tên', key: 'full_name' },
  { header: 'Ngày sinh', key: 'birth_date' },
  { header: 'Chức vụ', key: 'position' },
  { header: 'Team', key: 'team' },
  { header: 'Phòng ban', key: 'department' },
  { header: 'Email', key: 'email' },
  { header: 'SĐT', key: 'phone' },
];

const COL_MIN_WIDTH = 10;
const COL_MAX_WIDTH = 50;
const HEADER_ROW = 3; // row 1 = tiêu đề, row 2 = tháng + tổng, row 3 = header cột

/** birth_date (timestamptz, VN-midnight UTC) → DD/MM/YYYY theo giờ VN. */
function formatBirthDateVn(d: Date | string | null): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  return `${day}/${month}/${year}`;
}

@Injectable()
export class EmployeeBirthdayExportService {
  private readonly logger = new Logger(EmployeeBirthdayExportService.name);

  constructor(private readonly employeesService: EmployeesService) {}

  /** Xuất Excel danh sách sinh nhật theo tháng + bộ lọc (super_admin + hr). */
  async exportToExcel(dto: BirthdayListQueryDto, user: AuthUser): Promise<Buffer> {
    const { month, items } = await this.employeesService.getBirthdayList(
      dto,
      user,
      'employees.export',
    );
    this.logger.log(
      `Exporting ${items.length} birthday rows (month=${month})`,
    );
    return this.generateExcel(items, month);
  }

  private toCellValues(
    r: BirthdayItem,
    index: number,
  ): Record<string, string | number> {
    return {
      stt: index + 1,
      employee_code: r.employee_code ?? '',
      full_name: r.full_name ?? '',
      birth_date: formatBirthDateVn(r.birth_date),
      position: r.job_title_name ?? r.position ?? '',
      team: r.team_name ?? '',
      department: r.department ?? '',
      email: r.email ?? '',
      phone: r.phone ?? '',
    };
  }

  private async generateExcel(
    items: BirthdayItem[],
    month: number,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Trinity CRM';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Sinh nhật');
    const lastCol = COLUMNS.length;
    sheet.columns = COLUMNS.map((c) => ({ key: c.key }));

    // Hàng 1: tiêu đề (bold, merge)
    sheet.mergeCells(1, 1, 1, lastCol);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = 'DANH SÁCH SINH NHẬT NHÂN VIÊN';
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 2: tháng + tổng số
    sheet.mergeCells(2, 1, 2, lastCol);
    const subCell = sheet.getCell(2, 1);
    subCell.value = `Tháng ${month} · Tổng ${items.length} nhân viên`;
    subCell.font = { italic: true, color: { argb: 'FF666666' } };
    subCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 3: header cột — bold, nền xanh thương hiệu, chữ trắng
    const headerRow = sheet.getRow(HEADER_ROW);
    COLUMNS.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1D9452' },
      };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: false,
      };
    });

    // Dữ liệu (bắt đầu hàng 4)
    const cellValues = items.map((r, i) => this.toCellValues(r, i));
    for (const values of cellValues) {
      const row = sheet.addRow(values);
      COLUMNS.forEach((c, i) => {
        row.getCell(i + 1).alignment = {
          vertical: 'middle',
          horizontal: c.numeric ? 'right' : 'left',
          wrapText: false,
        };
      });
    }

    // Auto-fit độ rộng cột theo nội dung dài nhất.
    COLUMNS.forEach((c, i) => {
      let maxLen = c.header.length;
      for (const values of cellValues) {
        const v = values[c.key];
        const len = v === undefined || v === null ? 0 : String(v).length;
        if (len > maxLen) maxLen = len;
      }
      sheet.getColumn(i + 1).width = Math.min(
        COL_MAX_WIDTH,
        Math.max(COL_MIN_WIDTH, maxLen + 2),
      );
    });

    sheet.views = [{ state: 'frozen', ySplit: HEADER_ROW }];

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
