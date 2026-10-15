import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AttendanceService } from './attendance.service';
import type { QueryAttendanceExportDto } from './dto/query-attendance-export.dto';
import {
  cellDisplayText,
  STATUS_FILL,
  resolveFillKey,
} from './attendance-matrix.helper';

const HEADER_ROW = 3; // row 1 = tiêu đề, row 2 = khoảng ngày, row 3 = header cột
const DAY_COL_WIDTH = 5;
const COL_MIN_WIDTH = 8;
const COL_MAX_WIDTH = 40;
const FROZEN_COLS = 5; // STT | Mã NV | Họ tên | Team | Chức danh (+Team)

/** Tên tháng viết tắt (0-indexed) */
const MONTH_SHORT = [
  'T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12',
] as const;

function formatDateStr(d: string | null | undefined): string {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

@Injectable()
export class AttendanceMatrixExportService {
  private readonly logger = new Logger(AttendanceMatrixExportService.name);

  constructor(private readonly attendanceService: AttendanceService) {}

  /** Xuất Excel bảng chấm công tháng (lưới NV × ngày). */
  async exportMatrixToExcel(
    dto: QueryAttendanceExportDto,
    ownerIds: number[] | 'all',
  ): Promise<Buffer> {
    // forward bộ lọc Team/Phòng ban/Chức danh đang xem trên UI xuống Excel
    const m = await this.attendanceService.getWorkdaysMatrix({
      date_from: dto.date_from,
      date_to: dto.date_to,
      user_id: dto.user_id,
      team_id: dto.team_id,
      department: dto.department,
      job_title_id: dto.job_title_id,
    }, ownerIds);

    this.logger.log(
      `Exporting matrix ${m.count} NV × ${m.days_in_month} ngày (from=${dto.date_from ?? '-'} to=${dto.date_to ?? '-'})`,
    );

    const daysCount = m.days_in_month;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Trinity CRM';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Bảng công');

    // Tổng số cột = 4 cố định + daysCount ngày + 13 tổng kết
    const SUMMARY_HEADERS = [
      'Tổng công', 'Công sau duyệt', 'Tổng giờ', 'Đủ công', 'Chưa đủ',
      'Nghỉ phép', 'Thai sản', 'Đi muộn',
      'Lần về sớm', 'Phút về sớm', 'Đơn duyệt', 'Đơn từ chối', 'Ghi chú',
    ];
    const totalCols = FROZEN_COLS + daysCount + SUMMARY_HEADERS.length;

    // Hàng 1: tiêu đề (merge toàn bộ, bold 14)
    sheet.mergeCells(1, 1, 1, totalCols);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = 'BẢNG CHẤM CÔNG THÁNG';
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 2: khoảng ngày (italic, gray)
    sheet.mergeCells(2, 1, 2, totalCols);
    const subCell = sheet.getCell(2, 1);
    const fromStr = formatDateStr(dto.date_from);
    const toStr = formatDateStr(dto.date_to);
    const rangeStr = fromStr && toStr ? `${fromStr} – ${toStr}` : fromStr || toStr || 'Tất cả';
    subCell.value = `Khoảng thời gian: ${rangeStr} · Tổng ${m.count} nhân viên`;
    subCell.font = { italic: true, color: { argb: 'FF666666' } };
    subCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 3: header cột (bold, nền xanh thương hiệu, chữ trắng)
    const headerFill: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1D9452' },
    };
    const headerFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };
    const headerAlign: Partial<ExcelJS.Alignment> = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: false,
    };

    const setHeader = (col: number, value: string) => {
      const cell = sheet.getRow(HEADER_ROW).getCell(col);
      cell.value = value;
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.alignment = headerAlign;
    };

    setHeader(1, 'STT');
    setHeader(2, 'Mã NV');
    setHeader(3, 'Họ tên');
    setHeader(4, 'Team');
    setHeader(5, 'Chức danh');

    // Xác định tháng/năm từ date_from để tính thứ trong tuần cho header ngày.
    // Mặc định = tháng hiện tại theo giờ VN (không theo múi giờ máy chủ).
    const [vnYear, vnMonth] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' })
      .format(new Date())
      .slice(0, 7)
      .split('-')
      .map(Number);
    let year = vnYear;
    let month = vnMonth; // 1-based
    if (dto.date_from) {
      const parts = dto.date_from.split('-').map(Number);
      year = parts[0];
      month = parts[1];
    }

    // Header ngày = số ngày + thứ trong tuần (vd "1\nCN") — wrapText để xuống dòng.
    const DOW_VN = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    for (let d = 1; d <= daysCount; d++) {
      const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
      const cell = sheet.getRow(HEADER_ROW).getCell(FROZEN_COLS + d);
      cell.value = `${d}\n${DOW_VN[dow]}`;
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }

    SUMMARY_HEADERS.forEach((h, i) => {
      setHeader(FROZEN_COLS + daysCount + i + 1, h);
    });

    // Dữ liệu nhân viên
    const nameMaxLen = { val: 'Họ tên'.length };

    m.rows.forEach((row, idx) => {
      sheet.addRow([]);
      const rowNum = HEADER_ROW + 1 + idx;

      const setCell = (col: number, value: string | number, textFormat = false) => {
        const cell = sheet.getRow(rowNum).getCell(col);
        cell.value = value;
        if (textFormat) cell.numFmt = '@';
        cell.alignment = { vertical: 'middle', wrapText: false };
        return cell;
      };

      setCell(1, idx + 1);
      setCell(2, row.employee_code ?? `NV${String(row.user_id).padStart(4, '0')}`);
      const nameVal = row.full_name ?? '';
      setCell(3, nameVal);
      if (nameVal.length > nameMaxLen.val) nameMaxLen.val = nameVal.length;
      setCell(4, row.team_name ?? '');
      setCell(5, row.position ?? '');

      for (let d = 1; d <= daysCount; d++) {
        const cell = row.cells[d];
        const text = cell ? cellDisplayText(cell.status, cell.hours) : '·';
        const excelCell = setCell(FROZEN_COLS + d, text, true);

        const fillKey = cell
          ? resolveFillKey(cell.status, cell.late_minutes)
          : 'none';
        const argb = STATUS_FILL[fillKey];
        if (argb) {
          excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
        }
        excelCell.alignment = { horizontal: 'center', vertical: 'middle' };
      }

      // Cột tổng kết
      setCell(FROZEN_COLS + daysCount + 1, String(row.total_work_days), true);
      setCell(FROZEN_COLS + daysCount + 2, String(row.total_work_days_after_approval), true);
      setCell(FROZEN_COLS + daysCount + 3, row.total_hours.toFixed(1), true);
      setCell(FROZEN_COLS + daysCount + 4, row.present_days);
      setCell(FROZEN_COLS + daysCount + 5, row.half_days + row.insufficient_days);
      setCell(FROZEN_COLS + daysCount + 6, row.leave_days);
      setCell(FROZEN_COLS + daysCount + 7, row.maternity_days);
      setCell(FROZEN_COLS + daysCount + 8, row.late_days);
      setCell(FROZEN_COLS + daysCount + 9, row.early_leave_count);
      setCell(FROZEN_COLS + daysCount + 10, row.early_leave_minutes);
      setCell(FROZEN_COLS + daysCount + 11, row.early_leave_approved);
      setCell(FROZEN_COLS + daysCount + 12, row.early_leave_rejected);
      setCell(FROZEN_COLS + daysCount + 13, row.notes);

    });

    // Độ rộng cột: cố định, ngày, tổng kết
    sheet.getColumn(1).width = 6; // STT
    sheet.getColumn(2).width = 10; // Mã NV
    sheet.getColumn(3).width = Math.min(COL_MAX_WIDTH, Math.max(COL_MIN_WIDTH, nameMaxLen.val + 2));
    sheet.getColumn(4).width = 14; // Team
    sheet.getColumn(5).width = 16; // Chức danh

    for (let d = 1; d <= daysCount; d++) {
      sheet.getColumn(FROZEN_COLS + d).width = DAY_COL_WIDTH;
    }

    const SUMMARY_WIDTHS = [10, 13, 10, 8, 8, 10, 10, 9, 10, 11, 9, 10, 30];
    SUMMARY_WIDTHS.forEach((w, i) => {
      sheet.getColumn(FROZEN_COLS + daysCount + i + 1).width = w;
    });

    // 2D freeze: 3 header rows + 5 cột trái (STT | Mã NV | Họ tên | Team | Chức danh)
    sheet.views = [{ state: 'frozen', ySplit: HEADER_ROW, xSplit: FROZEN_COLS }];

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
