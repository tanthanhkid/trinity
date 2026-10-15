import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import type { QueryAttendanceExportDto } from './dto/query-attendance-export.dto';
import {
  AttendanceService,
  displayStatus,
  displayTotalHours,
  type ShiftConfig,
} from './attendance.service';
import {
  loadTeamOrgLookup,
  resolveTeamName,
  toOrgSortRow,
  compareByOrgOrder,
  intersectUserIdFilter,
  resolveTeamMemberUserIds,
  type OrgUserLite,
} from './attendance-org-sort.helper';

const EXPORT_LIMIT = 20_000;

// Khớp nhãn trạng thái với màn hình (attendance-detail-dialog STATUS_LABEL).
const STATUS_LABEL: Record<string, string> = {
  present: 'Đủ công',
  late: 'Đủ công',
  half_day: 'Nửa ngày',
  insufficient: 'Chưa đủ nửa ngày',
  incomplete: 'Chưa đủ vào/ra',
  absent: 'Vắng',
  leave: 'Nghỉ phép',
  maternity: 'Thai sản',
  review: 'Xem xét',
};

interface ColumnDef {
  header: string;
  key: string;
  /** Số = canh phải (ngày/giờ giữ chuỗi → canh trái) */
  numeric?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { header: 'Họ tên', key: 'full_name' },
  { header: 'Team', key: 'team_name' },
  { header: 'Phòng ban', key: 'department' },
  { header: 'Email', key: 'email' },
  { header: 'Chức danh', key: 'position' },
  { header: 'Ngày', key: 'work_date' },
  { header: 'Giờ vào', key: 'check_in' },
  { header: 'Giờ ra', key: 'check_out' },
  { header: 'Tổng giờ', key: 'total_hours', numeric: true },
  { header: 'Đi muộn (phút)', key: 'late_minutes', numeric: true },
  { header: 'Trạng thái', key: 'status' },
  { header: 'Ghi chú vào', key: 'in_note' },
  { header: 'Ghi chú ra', key: 'out_note' },
];

const COL_MIN_WIDTH = 10;
const COL_MAX_WIDTH = 50;
const HEADER_ROW = 3; // row 1 = tiêu đề, row 2 = khoảng thời gian, row 3 = header cột

/** Chuyển YYYY-MM-DD thành Date UTC 00:00:00 (khớp Prisma @db.Date) */
function parseDateToUtcMidnight(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** work_date (@db.Date, UTC midnight) → DD/MM/YYYY */
function formatWorkDate(d: Date): string {
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD
  const [y, m, day] = iso.split('-');
  return `${day}/${m}/${y}`;
}

/** Timestamp → HH:mm theo giờ VN */
function formatVnTime(d: Date | null): string {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

type ExportRowBase = Prisma.AttendanceRecordGetPayload<{
  include: {
    user: {
      select: {
        id: true;
        full_name: true;
        email: true;
        manager_id: true;
        employee: {
          select: {
            position: true;
            team_id: true;
            department: true;
            jobTitle: { select: { sort_order: true } };
          };
        };
      };
    };
  };
}>;

/** Team CHÍNH THỨC (resolve 3 tầng — xem attendance-org-sort.helper.ts). */
type ExportRow = ExportRowBase & { team_name: string | null };

@Injectable()
export class AttendanceExportService {
  private readonly logger = new Logger(AttendanceExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attendanceService: AttendanceService,
  ) {}

  /**
   * Xuất Excel chấm công trong khoảng ngày — scope THẬT theo `attendance.export`
   * (`ownerIds`: `'all'` hoặc mảng user_id own/team/subtree). Actor chỉ được
   * `attendance.export` scope `team` thì chỉ tải được dữ liệu trong team.
   */
  async exportToExcel(
    dto: QueryAttendanceExportDto,
    ownerIds: number[] | 'all',
  ): Promise<Buffer> {
    const where: Prisma.AttendanceRecordWhereInput = {};
    if (dto.date_from) {
      where.work_date = { gte: parseDateToUtcMidnight(dto.date_from) };
    }
    if (dto.date_to) {
      where.work_date = {
        ...(where.work_date as object),
        lte: parseDateToUtcMidnight(dto.date_to),
      };
    }
    if (ownerIds === 'all') {
      if (dto.user_id) where.user_id = dto.user_id;
    } else {
      where.user_id = intersectUserIdFilter(dto.user_id, ownerIds);
    }

    // forward bộ lọc Team/Phòng ban/Chức danh đang xem trên UI xuống Excel
    const employeeWhere: Record<string, unknown> = {};
    if (dto.department?.trim()) employeeWhere['department'] = dto.department.trim();
    if (dto.job_title_id) employeeWhere['job_title_id'] = dto.job_title_id;
    if (Object.keys(employeeWhere).length > 0) {
      (where as Record<string, unknown>)['user'] = { employee: employeeWhere };
    }
    // Team: resolve 3 tầng như bảng trên UI (cột thô employees.team_id bỏ sót trưởng nhóm/quản lý), rồi giao với phạm vi quyền.
    if (dto.team_id) {
      const teamUserIds = await resolveTeamMemberUserIds(this.prisma, dto.team_id);
      where.user_id = intersectUserIdFilter(where.user_id, teamUserIds);
    }

    const rawRows = (await this.prisma.attendanceRecord.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            full_name: true,
            email: true,
            manager_id: true,
            employee: {
              select: {
                position: true,
                team_id: true,
                department: true,
                jobTitle: { select: { sort_order: true } },
              },
            },
          },
        },
      },
      orderBy: [{ work_date: 'desc' }, { user_id: 'asc' }],
      take: EXPORT_LIMIT + 1, // +1 để biết có bị cắt hay không (cắt thì ghi cảnh báo vào file, không cắt lặng lẽ)
    })) as ExportRowBase[];
    const truncated = rawRows.length > EXPORT_LIMIT;
    if (truncated) rawRows.length = EXPORT_LIMIT;

    this.logger.log(
      `Exporting ${rawRows.length} attendance records (from=${dto.date_from ?? '-'} to=${dto.date_to ?? '-'})`,
    );

    // thứ tự Excel PHẢI khớp hoàn toàn giao diện — dùng CHUNG compareByOrgOrder với
    // attendance.service.ts::listRecords (sort_by='org' là mặc định của bảng Lịch sử chấm công).
    const orgLookup = await loadTeamOrgLookup(this.prisma);
    const rows: ExportRow[] = rawRows
      .map((r) => ({ ...r, team_name: resolveTeamName(r.user as OrgUserLite | null, orgLookup) }))
      .sort((a, b) => {
        const cmp = compareByOrgOrder(
          toOrgSortRow(a.user as OrgUserLite | null, a.team_name),
          toOrgSortRow(b.user as OrgUserLite | null, b.team_name),
        );
        if (cmp !== 0) return cmp;
        const dateCmp = a.work_date.getTime() - b.work_date.getTime();
        return dateCmp !== 0 ? dateCmp : a.id - b.id;
      });

    // total_hours + status TÍNH LẠI từ giờ chấm + cấu hình nghỉ trưa (KHÔNG dùng giá trị lưu DB
    // stale, chưa trừ nghỉ trưa) để Excel KHỚP với màn hình.
    const shiftConfig = await this.attendanceService.getShiftConfig();
    return this.generateExcel(rows, dto, shiftConfig, truncated);
  }

  private rangeLabel(dto: QueryAttendanceExportDto, count: number, truncated = false): string {
    const from = dto.date_from
      ? formatWorkDate(parseDateToUtcMidnight(dto.date_from))
      : null;
    const to = dto.date_to
      ? formatWorkDate(parseDateToUtcMidnight(dto.date_to))
      : null;
    const range =
      from && to
        ? from === to
          ? from
          : `${from} - ${to}`
        : 'Tất cả';
    const warn = truncated
      ? ` · ⚠ vượt ${EXPORT_LIMIT.toLocaleString('vi-VN')} bản ghi, file chỉ chứa ${EXPORT_LIMIT.toLocaleString('vi-VN')} bản ghi MỚI NHẤT — thu hẹp khoảng thời gian để xem đầy đủ`
      : '';
    return `Khoảng thời gian: ${range} · Tổng ${count} bản ghi${warn}`;
  }

  private toCellValues(
    r: ExportRow,
    shiftConfig: ShiftConfig,
  ): Record<string, string | number> {
    const computedStatus = displayStatus(r, shiftConfig);
    const computedHours = displayTotalHours(r, shiftConfig);
    return {
      full_name: r.user?.full_name ?? '',
      team_name: r.team_name ?? '',
      department: r.user?.employee?.department ?? '',
      email: r.user?.email ?? '',
      position: r.user?.employee?.position ?? '',
      work_date: formatWorkDate(r.work_date),
      check_in: formatVnTime(r.check_in_at),
      check_out: formatVnTime(r.check_out_at),
      total_hours: computedHours ?? '',
      late_minutes: r.late_minutes ?? 0,
      status: STATUS_LABEL[computedStatus] ?? computedStatus,
      in_note: r.check_in_note ?? '',
      out_note: r.check_out_note ?? '',
    };
  }

  private async generateExcel(
    rows: ExportRow[],
    dto: QueryAttendanceExportDto,
    shiftConfig: ShiftConfig,
    truncated = false,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Trinity CRM';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Chấm công');
    const lastCol = COLUMNS.length;
    // Chỉ set key (KHÔNG set header) → tự quản lý hàng tiêu đề + header thủ công.
    sheet.columns = COLUMNS.map((c) => ({ key: c.key }));

    // Hàng 1: tiêu đề báo cáo (bold, merge toàn bộ cột)
    sheet.mergeCells(1, 1, 1, lastCol);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = 'BÁO CÁO CHẤM CÔNG';
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 2: khoảng thời gian + tổng số bản ghi
    sheet.mergeCells(2, 1, 2, lastCol);
    const subCell = sheet.getCell(2, 1);
    subCell.value = this.rangeLabel(dto, rows.length, truncated);
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
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    });

    // Dữ liệu — addRow map theo key (bắt đầu hàng 4)
    const cellValues = rows.map((r) => this.toCellValues(r, shiftConfig));
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

    // Auto-fit độ rộng cột theo nội dung dài nhất (header + dữ liệu) → tránh bị che.
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
