import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  AttendanceService,
  resolveStatsRange,
  type TeamStatRow,
  type DepartmentStatRow,
  type DisciplineStats,
  type EmployeeAttendanceSummaryRow,
} from './attendance.service';
import type { QueryAttendanceStatsDto } from './dto/query-attendance-stats.dto';

interface ColumnDef {
  header: string;
  key: string;
  /** Số/STT canh phải, chữ canh trái */
  numeric?: boolean;
}

const TEAM_COLUMNS: ColumnDef[] = [
  { header: 'STT', key: 'stt', numeric: true },
  { header: 'Team', key: 'team_name' },
  { header: 'Tổng NV', key: 'headcount', numeric: true },
  { header: 'Đã chấm công', key: 'checked_in_people', numeric: true },
  { header: 'Có mặt', key: 'present_people', numeric: true },
  { header: 'Đi muộn', key: 'late_people', numeric: true },
  { header: 'Chưa đủ công', key: 'insufficient_people', numeric: true },
  { header: 'Vắng', key: 'absent_people', numeric: true },
  { header: 'Tỷ lệ chấm công (%)', key: 'attendance_rate', numeric: true },
  { header: 'Tổng phút muộn', key: 'total_late_minutes', numeric: true },
];

const DEPT_COLUMNS: ColumnDef[] = [
  { header: 'STT', key: 'stt', numeric: true },
  { header: 'Phòng ban', key: 'department' },
  { header: 'Trưởng phòng', key: 'head_name' },
  { header: 'Tổng NV', key: 'headcount', numeric: true },
  { header: 'Đã chấm công', key: 'checked_in_people', numeric: true },
  { header: 'Có mặt', key: 'present_people', numeric: true },
  { header: 'Đi muộn', key: 'late_people', numeric: true },
  { header: 'Chưa đủ công', key: 'insufficient_people', numeric: true },
  { header: 'Vắng', key: 'absent_people', numeric: true },
  { header: 'Tỷ lệ chấm công (%)', key: 'attendance_rate', numeric: true },
  { header: 'Tổng phút muộn', key: 'total_late_minutes', numeric: true },
];

// Sheet 2 (Chi tiết nhân viên) — 1 dòng/NV thuộc bộ lọc, đếm theo NGÀY (presence-based).
const EMP_DETAIL_COLUMNS: ColumnDef[] = [
  { header: 'STT', key: 'stt', numeric: true },
  { header: 'Mã NV', key: 'employee_code' },
  { header: 'Họ tên', key: 'full_name' },
  { header: 'Phòng ban', key: 'department' },
  { header: 'Team', key: 'team_name' },
  { header: 'Văn phòng', key: 'office_name' },
  { header: 'Ngày đã chấm', key: 'checked_in_days', numeric: true },
  { header: 'Ngày đủ công', key: 'full_days', numeric: true },
  { header: 'Ngày thiếu công', key: 'insufficient_days', numeric: true },
  { header: 'Ngày đi muộn', key: 'late_days', numeric: true },
  { header: 'Tổng phút muộn', key: 'total_late_minutes', numeric: true },
  { header: 'Ngày nghỉ phép', key: 'leave_days', numeric: true },
];

const TOP_ABSENT_COLUMNS: ColumnDef[] = [
  { header: 'STT', key: 'stt', numeric: true },
  { header: 'Mã NV', key: 'employee_code' },
  { header: 'Họ tên', key: 'full_name' },
  { header: 'Team', key: 'team_name' },
  { header: 'Chức vụ', key: 'position' },
  { header: 'Tổng ngày nghỉ', key: 'absent_days', numeric: true },
  { header: 'Tổng số lần nghỉ', key: 'absent_occurrences', numeric: true },
  { header: 'Tỷ lệ nghỉ (%)', key: 'absent_rate', numeric: true },
];

const TOP_LATE_EARLY_COLUMNS: ColumnDef[] = [
  { header: 'STT', key: 'stt', numeric: true },
  { header: 'Mã NV', key: 'employee_code' },
  { header: 'Họ tên', key: 'full_name' },
  { header: 'Team', key: 'team_name' },
  { header: 'Chức vụ', key: 'position' },
  { header: 'Phút đi muộn', key: 'late_minutes', numeric: true },
  { header: 'Phút về sớm', key: 'early_minutes', numeric: true },
  { header: 'Phút vi phạm', key: 'violation_minutes', numeric: true },
  { header: 'Số lần đi muộn', key: 'late_count', numeric: true },
  { header: 'Số lần về sớm', key: 'early_count', numeric: true },
];

const GENDER_COLUMNS: ColumnDef[] = [
  { header: 'Giới tính', key: 'gender_label' },
  { header: 'Tổng nhân sự', key: 'headcount', numeric: true },
  { header: 'Tổng ngày nghỉ', key: 'total_absent_days', numeric: true },
  { header: 'Tổng lần đi muộn', key: 'total_late_count', numeric: true },
  { header: 'Tổng lần về sớm', key: 'total_early_count', numeric: true },
  { header: 'Tỷ lệ đủ công (%)', key: 'full_attendance_rate', numeric: true },
  { header: 'Tỷ lệ thiếu công (%)', key: 'insufficient_rate', numeric: true },
];

const COL_MIN_WIDTH = 8;
const COL_MAX_WIDTH = 50;
const HEADER_ROW = 3; // row 1 = tiêu đề, row 2 = khoảng ngày, row 3 = header cột

/** YYYY-MM-DD → DD/MM/YYYY (chuỗi sẵn, không parse Date → tránh lệch timezone) */
function displayVnDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return d && m && y ? `${d}/${m}/${y}` : dateStr;
}

/**
 * Xuất Excel thống kê chấm công theo Team / Phòng ban. Tái dùng `AttendanceService.getStatsByTeam`
 * / `getStatsByDepartment(dto)` → file KHỚP đúng bộ lọc + khoảng ngày đang xem trên popup. Bố cục
 * đồng nhất `attendance-absent-export`: tiêu đề bold + dòng khoảng ngày, header cột bold nền xanh
 * thương hiệu, dữ liệu căn đều, auto-fit cột (tránh che/ghi đè), freeze header.
 */
@Injectable()
export class AttendanceStatsExportService {
  private readonly logger = new Logger(AttendanceStatsExportService.name);

  constructor(private readonly attendanceService: AttendanceService) {}

  async exportByTeam(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<Buffer> {
    const [rows, employees] = await Promise.all([
      this.attendanceService.getStatsByTeam(dto, scopeUserIds),
      this.attendanceService.getEmployeeAttendanceSummary(dto, scopeUserIds),
    ]);
    this.logger.log(
      `Exporting ${rows.length} team rows + ${employees.length} employees (2 sheets)`,
    );
    const workbook = this.newWorkbook();
    this.addSheet(
      workbook,
      'THỐNG KÊ CHẤM CÔNG THEO TEAM',
      this.subtitle(dto, rows.length, 'Team'),
      TEAM_COLUMNS,
      rows.map((r, i) => this.teamCells(r, i)),
      'Tổng quan theo Team',
    );
    this.addSheet(
      workbook,
      'CHI TIẾT NHÂN VIÊN THEO BỘ LỌC',
      this.empSubtitle(dto, employees.length),
      EMP_DETAIL_COLUMNS,
      employees.map((r, i) => this.empCells(r, i)),
      'Chi tiết nhân viên',
    );
    return this.finalize(workbook);
  }

  async exportByDepartment(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<Buffer> {
    const [rows, employees] = await Promise.all([
      this.attendanceService.getStatsByDepartment(dto, scopeUserIds),
      this.attendanceService.getEmployeeAttendanceSummary(dto, scopeUserIds),
    ]);
    this.logger.log(
      `Exporting ${rows.length} department rows + ${employees.length} employees (2 sheets)`,
    );
    const workbook = this.newWorkbook();
    this.addSheet(
      workbook,
      'THỐNG KÊ CHẤM CÔNG THEO PHÒNG BAN',
      this.subtitle(dto, rows.length, 'phòng ban'),
      DEPT_COLUMNS,
      rows.map((r, i) => this.deptCells(r, i)),
      'Tổng quan phòng ban',
    );
    this.addSheet(
      workbook,
      'CHI TIẾT NHÂN VIÊN THEO BỘ LỌC',
      this.empSubtitle(dto, employees.length),
      EMP_DETAIL_COLUMNS,
      employees.map((r, i) => this.empCells(r, i)),
      'Chi tiết nhân viên',
    );
    return this.finalize(workbook);
  }

  async exportTopAbsent(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<Buffer> {
    const stats = await this.attendanceService.getDisciplineStats(dto, scopeUserIds);
    const cells = stats.top_absent.map((r, i) => ({
      stt: i + 1,
      employee_code: r.employee_code ?? '',
      full_name: r.full_name ?? '',
      team_name: r.team_name,
      position: r.position ?? '',
      absent_days: r.absent_days,
      absent_occurrences: r.absent_occurrences,
      absent_rate: r.absent_rate,
    }));
    return this.generate(
      'TOP NHÂN VIÊN NGHỈ NHIỀU NHẤT',
      this.disciplineSubtitle(stats, `${stats.top_absent.length} nhân viên`),
      TOP_ABSENT_COLUMNS,
      cells,
      'Top nghỉ nhiều',
    );
  }

  async exportTopLateEarly(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<Buffer> {
    const stats = await this.attendanceService.getDisciplineStats(dto, scopeUserIds);
    const cells = stats.top_violation.map((r, i) => ({
      stt: i + 1,
      employee_code: r.employee_code ?? '',
      full_name: r.full_name ?? '',
      team_name: r.team_name,
      position: r.position ?? '',
      late_minutes: r.late_minutes,
      early_minutes: r.early_minutes,
      violation_minutes: r.violation_minutes,
      late_count: r.late_count,
      early_count: r.early_count,
    }));
    return this.generate(
      'TOP NHÂN VIÊN ĐI MUỘN / VỀ SỚM NHIỀU NHẤT',
      this.disciplineSubtitle(stats, `${stats.top_violation.length} nhân viên`),
      TOP_LATE_EARLY_COLUMNS,
      cells,
      'Top đi muộn-về sớm',
    );
  }

  async exportByGender(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<Buffer> {
    const stats = await this.attendanceService.getDisciplineStats(dto, scopeUserIds);
    const cells = stats.by_gender.map((r) => ({
      gender_label: r.gender_label,
      headcount: r.headcount,
      total_absent_days: r.total_absent_days,
      total_late_count: r.total_late_count,
      total_early_count: r.total_early_count,
      full_attendance_rate: r.full_attendance_rate,
      insufficient_rate: r.insufficient_rate,
    }));
    return this.generate(
      'SO SÁNH CHẤM CÔNG THEO GIỚI TÍNH',
      this.disciplineSubtitle(stats, `${stats.by_gender.length} nhóm`),
      GENDER_COLUMNS,
      cells,
      'Theo giới tính',
    );
  }

  private disciplineSubtitle(stats: DisciplineStats, count: string): string {
    return `Từ ${displayVnDate(stats.date_from)} đến ${displayVnDate(stats.date_to)} · ${stats.total_workdays} ngày làm việc · ${count}`;
  }

  private subtitle(
    dto: QueryAttendanceStatsDto,
    count: number,
    unit: string,
  ): string {
    const { fromStr, toStr } = resolveStatsRange(dto);
    return `Từ ${displayVnDate(fromStr)} đến ${displayVnDate(toStr)} · ${count} ${unit}`;
  }

  private teamCells(
    r: TeamStatRow,
    index: number,
  ): Record<string, string | number> {
    return {
      stt: index + 1,
      team_name: r.team_name ?? '',
      headcount: r.headcount,
      checked_in_people: r.checked_in_people,
      present_people: r.present_people,
      late_people: r.late_people,
      insufficient_people: r.insufficient_people,
      absent_people: r.absent_people,
      attendance_rate: r.attendance_rate,
      total_late_minutes: r.total_late_minutes,
    };
  }

  private deptCells(
    r: DepartmentStatRow,
    index: number,
  ): Record<string, string | number> {
    return {
      stt: index + 1,
      department: r.department ?? '',
      head_name: r.head_name ?? '',
      headcount: r.headcount,
      checked_in_people: r.checked_in_people,
      present_people: r.present_people,
      late_people: r.late_people,
      insufficient_people: r.insufficient_people,
      absent_people: r.absent_people,
      attendance_rate: r.attendance_rate,
      total_late_minutes: r.total_late_minutes,
    };
  }

  private empCells(
    r: EmployeeAttendanceSummaryRow,
    index: number,
  ): Record<string, string | number> {
    return {
      stt: index + 1,
      employee_code: r.employee_code ?? '',
      full_name: r.full_name ?? '',
      department: r.department ?? '',
      team_name: r.team_name ?? '',
      office_name: r.office_name ?? '',
      checked_in_days: r.checked_in_days,
      full_days: r.full_days,
      insufficient_days: r.insufficient_days,
      late_days: r.late_days,
      total_late_minutes: r.total_late_minutes,
      leave_days: r.leave_days,
    };
  }

  private empSubtitle(dto: QueryAttendanceStatsDto, count: number): string {
    const { fromStr, toStr } = resolveStatsRange(dto);
    return `Từ ${displayVnDate(fromStr)} đến ${displayVnDate(toStr)} · ${count} nhân viên`;
  }

  private newWorkbook(): ExcelJS.Workbook {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Trinity CRM';
    workbook.created = new Date();
    return workbook;
  }

  private async finalize(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /** Workbook 1 sheet (export top nghỉ / đi muộn-về sớm / giới tính). */
  private async generate(
    title: string,
    subtitle: string,
    columns: ColumnDef[],
    cellRows: Array<Record<string, string | number>>,
    sheetName: string,
  ): Promise<Buffer> {
    const workbook = this.newWorkbook();
    this.addSheet(workbook, title, subtitle, columns, cellRows, sheetName);
    return this.finalize(workbook);
  }

  /** Thêm 1 sheet (tiêu đề + khoảng ngày + header xanh thương hiệu + dữ liệu + auto-fit + freeze). */
  private addSheet(
    workbook: ExcelJS.Workbook,
    title: string,
    subtitle: string,
    columns: ColumnDef[],
    cellRows: Array<Record<string, string | number>>,
    sheetName: string,
  ): void {
    const sheet = workbook.addWorksheet(sheetName);
    const lastCol = columns.length;
    sheet.columns = columns.map((c) => ({ key: c.key }));

    // Hàng 1: tiêu đề báo cáo (bold, merge toàn bộ cột)
    sheet.mergeCells(1, 1, 1, lastCol);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = title;
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 2: khoảng ngày + tổng số dòng
    sheet.mergeCells(2, 1, 2, lastCol);
    const subCell = sheet.getCell(2, 1);
    subCell.value = subtitle;
    subCell.font = { italic: true, color: { argb: 'FF666666' } };
    subCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 3: header cột — bold, nền xanh thương hiệu, chữ trắng
    const headerRow = sheet.getRow(HEADER_ROW);
    columns.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D9452' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    });

    // Dữ liệu — addRow map theo key (bắt đầu hàng 4)
    cellRows.forEach((values) => {
      const row = sheet.addRow(values);
      columns.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        cell.alignment = {
          vertical: 'middle',
          horizontal: c.numeric ? 'right' : 'left',
          wrapText: false,
        };
      });
    });

    // Auto-fit độ rộng cột theo nội dung dài nhất (header + dữ liệu) → tránh bị che/ghi đè.
    columns.forEach((c, i) => {
      let maxLen = c.header.length;
      for (const values of cellRows) {
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
  }
}
