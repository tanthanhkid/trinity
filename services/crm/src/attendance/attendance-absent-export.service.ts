import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AttendanceService, type AbsentEmployee } from './attendance.service';

interface ColumnDef {
  header: string;
  key: string;
  /** Số/STT canh phải, chữ canh trái */
  numeric?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { header: 'STT', key: 'stt', numeric: true },
  { header: 'Mã NV', key: 'employee_code' },
  { header: 'Họ tên', key: 'full_name' },
  { header: 'SĐT', key: 'phone' },
  { header: 'Email', key: 'email' },
  { header: 'Team', key: 'team_name' },
  { header: 'Chức danh', key: 'position' },
  { header: 'Bộ phận', key: 'department' },
  { header: 'Giới tính', key: 'gender' },
  { header: 'Văn phòng', key: 'office_name' },
];

const COL_MIN_WIDTH = 8;
const COL_MAX_WIDTH = 50;
const HEADER_ROW = 3; // row 1 = tiêu đề, row 2 = ngày + tổng, row 3 = header cột

/** Bảng màu nền nhạt luân phiên theo TEAM (nhóm cùng team → cùng màu). */
const TEAM_FILLS = [
  'FFF1F8E9', 'FFE3F2FD', 'FFFFF3E0', 'FFF3E5F5',
  'FFFCE4EC', 'FFE0F7FA', 'FFFFF9C4', 'FFEFEBE9',
];

/** YYYY-MM-DD → DD/MM/YYYY (chuỗi sẵn, không parse Date → tránh lệch timezone) */
function displayVnDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return d && m && y ? `${d}/${m}/${y}` : dateStr;
}

function genderLabel(g: string | null): string {
  if (g === 'M') return 'Nam';
  if (g === 'F') return 'Nữ';
  return '';
}

/**
 * Xuất Excel danh sách nhân viên VẮNG (chưa chấm vào lẫn ra) trong 1 ngày.
 * Tái dùng `AttendanceService.getAbsentEmployees(dateStr, sortBy, sortDir)` → file KHỚP đúng
 * sort đang xem trên bảng FE. Bố cục đồng nhất attendance-export: tiêu đề bold + dòng ngày,
 * header cột bold nền xanh, dữ liệu căn đều, auto-fit cột (tránh che/ghi đè), freeze header.
 * Tô màu nền theo TEAM (nhóm cùng team → cùng màu) — khớp bảng FE.
 */
@Injectable()
export class AttendanceAbsentExportService {
  private readonly logger = new Logger(AttendanceAbsentExportService.name);

  constructor(private readonly attendanceService: AttendanceService) {}

  async exportAbsentToExcel(
    dateStr: string,
    sortBy?: string,
    sortDir?: string,
    scopeUserIds?: number[] | null,
  ): Promise<Buffer> {
    const rows = await this.attendanceService.getAbsentEmployees(
      dateStr,
      sortBy,
      sortDir,
      scopeUserIds,
    );
    this.logger.log(`Exporting ${rows.length} absent employees for ${dateStr}`);
    return this.generateExcel(rows, dateStr);
  }

  private toCellValues(r: AbsentEmployee, index: number): Record<string, string | number> {
    return {
      stt: index + 1,
      employee_code: r.employee_code ?? '',
      full_name: r.full_name ?? '',
      phone: r.phone ?? '',
      email: r.email ?? '',
      team_name: r.team_name ?? '',
      position: r.position ?? '',
      department: r.department ?? '',
      gender: genderLabel(r.gender),
      office_name: r.office_name ?? '',
    };
  }

  /** Map team_id → màu nền (theo thứ tự xuất hiện). team null → không tô. */
  private buildTeamColorMap(rows: AbsentEmployee[]): Map<number, string> {
    const map = new Map<number, string>();
    let next = 0;
    for (const r of rows) {
      if (r.team_id == null) continue;
      if (!map.has(r.team_id)) {
        map.set(r.team_id, TEAM_FILLS[next % TEAM_FILLS.length]);
        next += 1;
      }
    }
    return map;
  }

  private async generateExcel(rows: AbsentEmployee[], dateStr: string): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Trinity CRM';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('NV chưa chấm công');
    const lastCol = COLUMNS.length;
    sheet.columns = COLUMNS.map((c) => ({ key: c.key }));

    // Hàng 1: tiêu đề báo cáo (bold, merge toàn bộ cột)
    sheet.mergeCells(1, 1, 1, lastCol);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = 'DANH SÁCH NHÂN VIÊN CHƯA CHẤM CÔNG';
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 2: ngày + tổng số nhân viên vắng
    sheet.mergeCells(2, 1, 2, lastCol);
    const subCell = sheet.getCell(2, 1);
    subCell.value = `Ngày: ${displayVnDate(dateStr)} · Tổng ${rows.length} nhân viên vắng`;
    subCell.font = { italic: true, color: { argb: 'FF666666' } };
    subCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 3: header cột — bold, nền xanh thương hiệu, chữ trắng
    const headerRow = sheet.getRow(HEADER_ROW);
    COLUMNS.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D9452' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    });

    // Dữ liệu — addRow map theo key (bắt đầu hàng 4) + tô màu nền theo team.
    const teamColors = this.buildTeamColorMap(rows);
    const cellValues = rows.map((r, i) => this.toCellValues(r, i));
    rows.forEach((r, idx) => {
      const row = sheet.addRow(cellValues[idx]);
      const fill = r.team_id != null ? teamColors.get(r.team_id) : undefined;
      COLUMNS.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        cell.alignment = {
          vertical: 'middle',
          horizontal: c.numeric ? 'right' : 'left',
          wrapText: false,
        };
        if (fill) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        }
      });
    });

    // Auto-fit độ rộng cột theo nội dung dài nhất (header + dữ liệu) → tránh bị che/ghi đè.
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
