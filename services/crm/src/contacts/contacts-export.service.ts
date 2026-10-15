import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { type AuthUser, ScopeService, makePhoneMasker } from '@trinity/rbac-nest';
import { resolveOwnerPlacements, OrgPlacement } from '../common/helpers/org-placement.helper';
import { deriveContactStage } from './helpers/derive-stage.helper';
import {
  buildScopedContactListWhere,
  ContactListFilters,
} from './helpers/build-contact-list-where.helper';

/**
 * Select CƠ SỞ + 2 cột nhạy cảm (SĐT/SĐT phụ) LUÔN select — RBAC
 * quyền + phạm vi đổi từ "role được thấy cả cột hay không"
 * sang che PER-ROW theo `contacts.phone_full` (Mẫu C, mirror list/detail) —
 * không còn cách nào loại cột khỏi Prisma select theo "vai trò" vì owner của
 * từng dòng khác nhau. KHÔNG dùng CONTACT_LIST_SELECT (thiếu field chi tiết
 * như địa chỉ).
 */
const EXPORT_SELECT = {
  id: true,
  full_name: true,
  zalo_account: true,
  assigned_to: true,
  created_by_id: true,
  created_at: true,
  phone: true,
  phone_2: true,
  gender: true,
  birthday: true,
  job_title: true,
  current_address: true,
  company_name: true,
  email: true,
  assigned_user: { select: { full_name: true } },
  creator: { select: { full_name: true } },
  source: { select: { label: true } },
  stage: { select: { label: true } },
  contact_status: { select: { label: true } },
} as const;

/** Cast tường minh cho Prisma select. */
const CONTACT_SELECT_ARG = EXPORT_SELECT as Prisma.ContactSelect;

type ContactRow = Prisma.ContactGetPayload<{ select: typeof EXPORT_SELECT }>;

/** Cap cứng — bảo vệ memory/thời gian request (bảng lớn, scope `all` không
 * giới hạn). Vượt cap → cảnh báo ở dòng đầu file (KHÔNG âm thầm cắt cụt). */
const EXPORT_LIMIT = 20_000;
/** Ngày xuất theo giờ VN, không theo múi giờ máy chủ (UTC trên Vercel/VPS lệch ngày). */
const VN_TZ = { timeZone: 'Asia/Ho_Chi_Minh' } as const;
const BATCH_SIZE = 500;

const GENDER_LABELS: Record<string, string> = { nam: 'Nam', nu: 'Nữ' };
const NO_DEPT_LABEL = 'Chưa phân phòng';
const NO_TEAM_LABEL = 'Chưa phân team';
const NO_ASSIGNEE_LABEL = 'Chưa gán';
const SORT_LAST = '￿';

@Injectable()
export class ContactsExportService {
  private readonly logger = new Logger(ContactsExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * Export danh bạ trong phạm vi `contacts.view` của user, ÁP filter UI đang
   * chọn (Giai đoạn/Nguồn/Dự án... thu hẹp phạm vi file xuất). Where-clause DÙNG CHUNG với `GET /contacts` list
   * qua `buildScopedContactListWhere` — filter thu hẹp phạm vi TRƯỚC, cap
   * `EXPORT_LIMIT` áp SAU trên phạm vi đã thu hẹp đó. Sort trình bày Phòng
   * ban → Team → NV phụ trách → Khách hàng (KHÔNG liên quan tới sort_by/
   * sort_order của list — 2 field đó KHÔNG được forward).
   *
   * RBAC quyền + phạm vi: SĐT/SĐT phụ che PER-ROW theo `contacts.phone_full`.
   * Ai có `contacts.phone_full` phủ đúng owner của dòng đó thấy dòng đó, bất kể
   * role tên gì.
   */
  async exportToExcel(user: AuthUser, filters: ContactListFilters): Promise<Buffer> {
    const where = await buildScopedContactListWhere(this.prisma, this.scope, user, filters);
    const { rows, truncated } = await this.fetchAllContacts(where);
    const placements = await resolveOwnerPlacements(
      this.prisma,
      rows.map((r) => r.assigned_to),
    );

    this.logger.log(`Exporting ${rows.length} contacts by user ${user.userId}`);

    const phoneFullOwners = await this.scope.ownerIds(user, 'contacts.phone_full');
    const maskRow = makePhoneMasker(phoneFullOwners ?? []);
    const canSeeSensitive = (row: ContactRow): boolean =>
      phoneFullOwners === 'all' ||
      (Array.isArray(phoneFullOwners) &&
        [row.assigned_to, row.created_by_id].some((id) => id != null && phoneFullOwners.includes(id)));

    const sorted = this.sortRows(rows, placements);
    return this.generateExcel(sorted, placements, truncated, maskRow, canSeeSensitive);
  }

  /**
   * Fetch theo cursor pagination (bảng contacts lớn — KHÔNG offset lớn), cap EXPORT_LIMIT.
   * Vòng lặp fetch tới khi VƯỢT EXPORT_LIMIT (không dừng NGAY KHI CHẠM mốc) để phân
   * biệt chính xác "vừa đủ EXPORT_LIMIT bản ghi" (không truncate) với "còn dư data"
   * (có truncate) — tránh false-positive cảnh báo cắt cụt khi tổng số bản ghi đúng
   * bằng bội số của BATCH_SIZE và bằng EXPORT_LIMIT.
   *
   * ⚠️ `orderBy: { id: 'desc' }` (tránh "trần dòng + ORDER BY ASC"
   * im lặng cắt mất dữ liệu MỚI NHẤT) — sort `asc` sẽ khiến khi
   * phạm vi (đã lọc) vượt EXPORT_LIMIT, file giữ lại NHỮNG DÒNG CŨ NHẤT và âm thầm bỏ rơi
   * dữ liệu mới tạo gần đây. Dùng `desc` để cap giữ lại
   * EXPORT_LIMIT bản ghi MỚI NHẤT trong phạm vi đã lọc. `sortRows()` ngay sau
   * đó re-sort toàn bộ theo tổ chức (Phòng ban→Team→NV→Khách hàng) để trình
   * bày — thứ tự fetch ở đây CHỈ quyết định "dòng nào được GIỮ LẠI khi vượt cap",
   * không ảnh hưởng thứ tự hiển thị cuối cùng trong file.
   */
  private async fetchAllContacts(
    where: Prisma.ContactWhereInput,
  ): Promise<{ rows: ContactRow[]; truncated: boolean }> {
    const allRows: ContactRow[] = [];
    let cursor: number | undefined;

    while (allRows.length <= EXPORT_LIMIT) {
      const batch = await this.prisma.contact.findMany({
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        where,
        orderBy: { id: 'desc' },
        select: CONTACT_SELECT_ARG,
      });

      if (batch.length === 0) break;

      allRows.push(...(batch as unknown as ContactRow[]));
      cursor = batch[batch.length - 1].id;

      if (batch.length < BATCH_SIZE) break;
    }

    const truncated = allRows.length > EXPORT_LIMIT;
    return { rows: allRows.slice(0, EXPORT_LIMIT), truncated };
  }

  /** Sort Phòng ban → Team → NV phụ trách → Khách hàng (nulls xếp cuối mỗi cấp). */
  private sortRows(
    rows: ContactRow[],
    placements: Map<number, OrgPlacement>,
  ): ContactRow[] {
    const keyOf = (row: ContactRow): string => {
      const place = row.assigned_to != null ? placements.get(row.assigned_to) : undefined;
      const dept = place?.deptName ?? SORT_LAST;
      const team = place?.teamName ?? SORT_LAST;
      const assignee = row.assigned_user?.full_name ?? SORT_LAST;
      const customer = row.full_name ?? SORT_LAST;
      return `${dept} ${team} ${assignee} ${customer}`;
    };
    return [...rows].sort((a, b) => keyOf(a).localeCompare(keyOf(b), 'vi'));
  }

  /**
   * RBAC quyền + phạm vi: cột SĐT/SĐT phụ LUÔN có mặt trong sheet — che PER-DÒNG
   * (Mẫu C, `addDataRows`). Owner của từng dòng khác nhau nên không có khái niệm
   * "role này được cả cột hay không".
   */
  private getColumnDefinitions(): Partial<ExcelJS.Column>[] {
    return [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Tên KH', key: 'full_name', width: 24 },
      { header: 'SĐT', key: 'phone', width: 14 },
      { header: 'SĐT phụ', key: 'phone_2', width: 14 },
      { header: 'Giai đoạn', key: 'stage', width: 20 },
      { header: 'Trạng thái', key: 'contact_status', width: 18 },
      { header: 'Nguồn', key: 'source', width: 16 },
      { header: 'Phòng ban', key: 'dept', width: 22 },
      { header: 'Team', key: 'team', width: 22 },
      { header: 'Nhân viên phụ trách', key: 'assignee', width: 20 },
      { header: 'Ngày tạo', key: 'created_at', width: 14 },
      { header: 'Người khởi tạo', key: 'creator', width: 20 },
      { header: 'Giới tính', key: 'gender', width: 10 },
      { header: 'Ngày sinh', key: 'birthday', width: 14 },
      { header: 'Chức danh', key: 'job_title', width: 18 },
      { header: 'Địa chỉ hiện tại', key: 'current_address', width: 28 },
      { header: 'Công ty', key: 'company_name', width: 22 },
      { header: 'Email', key: 'email', width: 22 },
      { header: 'Zalo', key: 'zalo_account', width: 16 },
    ];
  }

  private styleHeaderRow(sheet: ExcelJS.Worksheet): void {
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1D9452' },
    };
  }

  /**
   * RBAC quyền + phạm vi: che SĐT/SĐT phụ
   * PER-DÒNG qua `maskRow`/`canSeeSensitive` (Mẫu C) — mirror `contacts.phone_full`
   * của list/detail. Cột LUÔN có mặt (xem `getColumnDefinitions`); dòng nằm
   * ngoài phạm vi `contacts.phone_full` của người xuất thì HIỆN dòng đó với
   * SĐT che (`***xxx`), KHÔNG loại cả cột.
   */
  private addDataRows(
    sheet: ExcelJS.Worksheet,
    rows: ContactRow[],
    placements: Map<number, OrgPlacement>,
    maskRow: (ownerIds: (number | null | undefined)[], phone: string | null) => string | null,
    canSeeSensitive: (row: ContactRow) => boolean,
  ): void {
    rows.forEach((row, idx) => {
      const place = row.assigned_to != null ? placements.get(row.assigned_to) : undefined;
      const ownerIds = [row.assigned_to, row.created_by_id];
      const sensitive = canSeeSensitive(row);
      const rowData: Record<string, unknown> = {
        stt: idx + 1,
        full_name: row.full_name ?? '',
        stage: deriveContactStage(row).label,
        contact_status: row.contact_status?.label ?? '',
        source: row.source?.label ?? '',
        dept: place?.deptName ?? NO_DEPT_LABEL,
        team: place?.teamName ?? NO_TEAM_LABEL,
        assignee: row.assigned_user?.full_name ?? NO_ASSIGNEE_LABEL,
        created_at: row.created_at.toLocaleDateString('vi-VN', VN_TZ),
        creator: row.creator?.full_name ?? '',
        gender: row.gender ? (GENDER_LABELS[row.gender] ?? row.gender) : '',
        birthday: row.birthday ? row.birthday.toLocaleDateString('vi-VN', VN_TZ) : '',
        job_title: row.job_title ?? '',
        current_address: row.current_address ?? '',
        company_name: row.company_name ?? '',
        email: row.email ?? '',
        zalo_account: row.zalo_account ?? '',
        phone: maskRow(ownerIds, row.phone) ?? '',
        phone_2: maskRow(ownerIds, row.phone_2) ?? '',
      };
      sheet.addRow(rowData);
    });
  }

  private async generateExcel(
    rows: ContactRow[],
    placements: Map<number, OrgPlacement>,
    truncated: boolean,
    maskRow: (ownerIds: (number | null | undefined)[], phone: string | null) => string | null,
    canSeeSensitive: (row: ContactRow) => boolean,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Trinity CRM';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Khách hàng');
    const columnDefs = this.getColumnDefinitions();
    sheet.columns = columnDefs;
    this.styleHeaderRow(sheet);
    this.addDataRows(sheet, rows, placements, maskRow, canSeeSensitive);

    let headerSplit = 1;
    if (truncated) {
      // Chèn dòng cảnh báo NGAY DƯỚI header (row 2) — spliceRows đẩy toàn bộ
      // data rows xuống 1 dòng, KHÔNG đụng row 1 (header) đã style sẵn.
      sheet.spliceRows(2, 0, [
        `⚠ Dữ liệu (trong phạm vi bộ lọc đang chọn) vượt quá ${EXPORT_LIMIT.toLocaleString('vi-VN')} bản ghi — file chỉ chứa ${EXPORT_LIMIT.toLocaleString('vi-VN')} bản ghi MỚI NHẤT (trình bày theo Phòng ban → Team → NV phụ trách → Khách hàng). Thu hẹp bộ lọc để xem đầy đủ.`,
      ]);
      sheet.mergeCells(2, 1, 2, columnDefs.length);
      sheet.getRow(2).font = { bold: true, color: { argb: 'FFB45309' } };
      headerSplit = 2;
    }
    sheet.views = [{ state: 'frozen', ySplit: headerSplit }];

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
