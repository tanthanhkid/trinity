import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import type { AuthUser } from '@trinity/rbac-nest';
import { EmployeesService } from './employees.service';
import { QueryEmployeesDto } from './dto/query-employees.dto';

// Một dòng nhân viên đã map (đồng bộ với output findAllForExport).
type EmployeeRow = Awaited<
  ReturnType<EmployeesService['findAllForExport']>
>[number];

interface ColumnDef {
  header: string;
  key: string;
  numeric?: boolean;
}

// Cột xuất = toàn bộ trường hiển thị trong popup "Chi tiết nhân viên" + STT.
const COLUMNS: ColumnDef[] = [
  { header: 'STT', key: 'stt', numeric: true },
  { header: 'Mã NV', key: 'employee_code' },
  { header: 'Họ tên', key: 'full_name' },
  { header: 'Email', key: 'email' },
  { header: 'Số điện thoại', key: 'phone' },
  { header: 'Chức vụ', key: 'position' },
  { header: 'Phòng ban', key: 'department' },
  { header: 'Team', key: 'team_name' },
  { header: 'Giới tính', key: 'gender' },
  { header: 'Vai trò hệ thống', key: 'role' },
  { header: 'Trạng thái', key: 'status' },
  { header: 'Ngày vào làm', key: 'joined_at' },
  { header: 'Trình độ học vấn', key: 'education_level' },
  { header: 'Nguồn tuyển dụng', key: 'recruitment_source' },
  { header: 'Ngày sinh', key: 'birth_date' },
  { header: 'Số CCCD', key: 'id_card_number' },
  { header: 'Ngày cấp CCCD', key: 'id_card_issued_date' },
  { header: 'Nơi cấp CCCD', key: 'id_card_issued_place' },
  { header: 'Hộ khẩu thường trú', key: 'permanent_address' },
  { header: 'Chỗ ở hiện tại', key: 'current_address' },
  { header: 'Số tài khoản', key: 'bank_account_number' },
  { header: 'Tên ngân hàng', key: 'bank_name' },
  { header: 'Tên chủ tài khoản', key: 'bank_account_holder' },
  { header: 'Ngày tạo', key: 'created_at' },
];

const COL_MIN_WIDTH = 10;
const COL_MAX_WIDTH = 50;
const HEADER_ROW = 2; // row 1 = tiêu đề + tổng số, row 2 = header cột

// Nhãn tiếng Việt — mirror apps/web/src/app/(dashboard)/management/employees/page.tsx.
const STATUS_LABELS: Record<string, string> = {
  unclassified: 'Chưa phân loại',
  active: 'Đang làm việc',
  probation: 'Thử việc',
  waiting: 'Chờ vào làm',
  on_leave: 'Tạm nghỉ',
  resigned: 'Nghỉ việc',
};

const GENDER_LABELS: Record<string, string> = { M: 'Nam', F: 'Nữ' };

const EDUCATION_LABELS: Record<string, string> = {
  dai_hoc_tro_len: 'Đại học trở lên',
  cao_dang: 'Cao đẳng',
  trung_cap: 'Trung cấp',
  thpt_12: 'THPT (12/12)',
  thcs: 'THCS',
  khac: 'Khác',
};

const RECRUITMENT_LABELS: Record<string, string> = {
  hr: 'HR tuyển',
  internal: 'Nội bộ giới thiệu',
};

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Quản trị viên',
  hr: 'Hành chính nhân sự',
  team_lead: 'Trưởng nhóm',
  sale: 'Nhân viên sale',
  accountant: 'Kế toán',
  marketing: 'Marketing',
};

/** Date (timestamptz, VN-midnight UTC) → DD/MM/YYYY theo giờ VN. */
function formatDateVn(d: Date | string | null): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '';
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
export class EmployeeListExportService {
  private readonly logger = new Logger(EmployeeListExportService.name);

  constructor(private readonly employeesService: EmployeesService) {}

  /**
   * Xuất Excel danh sách nhân viên theo bộ lọc + sắp xếp hiện hành.
   * Tái dùng findAllForExport → file khớp 100% với danh sách đang hiển thị,
   * scope theo quyền `employees.export` (own|team|subtree|all) của actor.
   */
  async exportToExcel(dto: QueryEmployeesDto, user: AuthUser): Promise<Buffer> {
    const rows = await this.employeesService.findAllForExport(dto, user);
    this.logger.log(`Exporting ${rows.length} employee rows`);
    return this.generateExcel(rows);
  }

  private toCellValues(
    r: EmployeeRow,
    index: number,
  ): Record<string, string | number> {
    return {
      stt: index + 1,
      employee_code: r.employee_code ?? '',
      full_name: r.full_name ?? '',
      email: r.email ?? '',
      phone: r.phone ?? '',
      position: r.position ?? '',
      department: r.department ?? '',
      team_name: r.team_name ?? '',
      gender: r.gender ? (GENDER_LABELS[r.gender] ?? r.gender) : '',
      role: r.role ? (ROLE_LABELS[r.role] ?? r.role) : '',
      status: this.statusLabel(r.status, r.user_status),
      joined_at: formatDateVn(r.joined_at),
      education_level: r.education_level
        ? (EDUCATION_LABELS[r.education_level] ?? r.education_level)
        : '',
      recruitment_source: r.recruitment_source
        ? (RECRUITMENT_LABELS[r.recruitment_source] ?? r.recruitment_source)
        : '',
      birth_date: formatDateVn(r.birth_date),
      id_card_number: r.id_card_number ?? '',
      id_card_issued_date: formatDateVn(r.id_card_issued_date),
      id_card_issued_place: r.id_card_issued_place ?? '',
      permanent_address: r.permanent_address ?? '',
      current_address: r.current_address ?? '',
      bank_account_number: r.bank_account_number ?? '',
      bank_name: r.bank_name ?? '',
      bank_account_holder: r.bank_account_holder ?? '',
      created_at: formatDateVn(r.created_at),
    };
  }

  // Tài khoản bị khoá (user_status='locked') = đã nghỉ việc — mirror resolveEmployeeDisplayStatus.
  private statusLabel(
    status: string | null,
    userStatus: string | null | undefined,
  ): string {
    const effective = userStatus === 'locked' ? 'resigned' : status;
    if (!effective) return '';
    return STATUS_LABELS[effective] ?? effective;
  }

  private async generateExcel(rows: EmployeeRow[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Trinity CRM';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Nhân viên');
    const lastCol = COLUMNS.length;
    sheet.columns = COLUMNS.map((c) => ({ key: c.key }));

    // Hàng 1: tiêu đề + tổng số (bold, merge)
    sheet.mergeCells(1, 1, 1, lastCol);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = `DANH SÁCH NHÂN VIÊN · Tổng ${rows.length} nhân viên`;
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Hàng 2: header cột — bold, nền xanh thương hiệu, chữ trắng
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

    // Dữ liệu (bắt đầu hàng 3)
    const cellValues = rows.map((r, i) => this.toCellValues(r, i));
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

    // Auto-fit độ rộng cột theo nội dung dài nhất (tránh che / xuống dòng bất thường).
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
