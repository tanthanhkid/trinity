import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import { ScopeService, runInBackground, type AuthUser } from '@trinity/rbac-nest';
import { findUserIdsWithPermission } from '../common/helpers/permission-roster.helper';
import type { QueryAttendanceDto, QueryTodaySummaryDto } from './dto/query-attendance.dto';
import type { QueryAttendanceStatsDto } from './dto/query-attendance-stats.dto';
import type { PatchAttendanceDto } from './dto/patch-attendance.dto';
import type { UpdateAttendanceSettingsDto } from './dto/update-attendance-settings.dto';
import type { CreateOfficeDto, UpdateOfficeDto } from './dto/office.dto';
import type { CreateAttendanceRequestDto } from './dto/create-attendance-request.dto';
import type { UpdateRequestConfigDto } from './dto/update-request-config.dto';
import type { QueryAttendanceRequestsDto } from './dto/query-attendance-requests.dto';
import type { RejectRequestDto } from './dto/reject-request.dto';
import { extractClientIp, ipMatchesOffice } from './attendance-ip.helper';
import {
  MATRIX_RECORD_CAP,
  type MatrixRow,
  type DayCell,
  daysInMonthFromDateFrom,
  computeNotes,
  vnHhmm,
} from './attendance-matrix.helper';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SELFIE_MIME_EXT } from './attendance.constants';
import {
  loadTeamOrgLookup,
  resolveTeamName,
  toOrgSortRow,
  compareByOrgOrder,
  RESOLVED_TEAM_ID_SQL,
  resolveTeamMemberUserIds,
  intersectUserIdFilter,
  type OrgUserLite,
} from './attendance-org-sort.helper';
import type { Request } from 'express';
import type { Readable } from 'stream';

// Nhãn tiếng Việt cho từng loại đơn chấm công — dùng trong tiêu đề thông báo.
const ATTENDANCE_REQUEST_TYPE_LABEL: Record<string, string> = {
  forgot_check_in: 'Quên check-in',
  forgot_check_out: 'Quên check-out',
  late_arrival: 'Đi muộn',
  early_leave: 'Về sớm',
  leave: 'Nghỉ phép',
  maternity: 'Nghỉ thai sản',
};

/**
 * Thứ tự + nhãn 6 loại đơn cho biểu đồ "Phân tích nghỉ phép" — GIỮ thứ tự cố định để
 * bảng màu donut nhất quán giữa các tháng. Trả đủ 6 loại kể cả value=0 (giữ legend ổn định).
 */
const LEAVE_ANALYTICS_TYPES: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'forgot_check_in', label: 'Quên chấm vào' },
  { type: 'forgot_check_out', label: 'Quên chấm ra' },
  { type: 'late_arrival', label: 'Đến muộn' },
  { type: 'early_leave', label: 'Về sớm' },
  { type: 'leave', label: 'Nghỉ phép' },
  { type: 'maternity', label: 'Nghỉ thai sản' },
];

/** Nhãn nhóm giới tính cho biểu đồ "Phân tích nghỉ phép". */
const LEAVE_GENDER_LABELS: Record<'M' | 'F' | 'unknown', string> = {
  M: 'Nam',
  F: 'Nữ',
  unknown: 'Khác',
};

// Cấu hình ca làm việc — lưu KV trong bảng settings. late_after = mốc tính đi muộn.
const ATTENDANCE_SHIFT_KEY = 'attendance_shift_config';

// Cấu hình đơn chấm công — lưu KV trong bảng settings.
const ATTENDANCE_REQUEST_CFG_KEY = 'attendance_request_config';
// Danh sách thứ 7 ĐƯỢC TÍNH đi làm (YYYY-MM-DD) — super_admin/hr cấu hình.
// T2–T6 mặc định luôn là ngày làm; CN nghỉ; thứ 7 chỉ tính khi nằm trong danh sách này.
const ATTENDANCE_WORKING_SAT_KEY = 'attendance_working_saturdays';
const SAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_SHIFT_CONFIG = {
  work_start: '08:00',
  work_end: '17:00',
  late_after: '08:10',
  // Giờ nghỉ trưa — khoảng [lunch_start, lunch_end] rơi vào giờ làm sẽ TỰ TRỪ.
  // Mặc định 12:00–13:30 (Setting KV `attendance_shift_config` đã lưu sẽ ghi đè fallback này).
  lunch_start: '12:00',
  lunch_end: '13:30',
  // Ngưỡng giờ công cấu hình được (4 bậc): tổng < review_max_hours → "Xem xét" (đỏ);
  // [review_max, half_day_min) → "Chưa đủ nửa ngày"; [half_day_min, full_day_min) → "Nửa ngày";
  // >= full_day_min_hours → đủ công.
  review_max_hours: 1,
  half_day_min_hours: 4,
  full_day_min_hours: 8,
} as const;

/** Số giờ của 1 ngày công đầy đủ (nghỉ phép/thai sản tính = ngày công đủ). */
const STANDARD_WORK_HOURS = 8;

/** Trần bản ghi nạp khi LỌC theo trạng thái (status tính lại app-side nên không lọc/đếm DB được).
 *  Phạm vi ngày mặc định hẹp (hôm nay) → đủ; chỉ vượt khi lọc status trên khoảng rất rộng. */
const STATUS_FILTER_CAP = 5000;

/**
 * trần bản ghi nạp khi sort_by='org' (app-layer, không có orderBy DB tương ứng).
 * PHẢI khớp `EXPORT_LIMIT` (attendance-export.service.ts) — nếu 2 cap lệch nhau, listRecords
 * và exportToExcel có thể fetch 2 TẬP DỮ LIỆU KHÁC NHAU trên khoảng ngày rất rộng (>5000 bản
 * ghi) → Excel không còn khớp hoàn toàn giao diện.
 */
const ORG_SORT_CAP = 20_000;

/** Kiểu cấu hình ca làm việc trả về bởi getShiftConfig */
export type ShiftConfig = {
  work_start: string;
  work_end: string;
  late_after: string;
  lunch_start: string;
  lunch_end: string;
  review_max_hours: number;
  half_day_min_hours: number;
  full_day_min_hours: number;
};
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Một nhân viên VẮNG (chưa chấm CẢ vào lẫn ra) trong 1 ngày — dùng cho bảng + xuất Excel. */
export type AbsentEmployee = {
  user_id: number;
  employee_code: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  department: string | null;
  gender: string | null; // 'M' | 'F' | null
  office_name: string | null;
  team_name: string | null; // tên quản lý trực tiếp (team_lead) — = "Team"
  team_id: number | null; // = users.manager_id — khoá nhóm để tô màu cùng team
};

/** Trần số NV vắng nạp 1 lần (toàn công ty ~vài trăm NV → đủ rộng). */
const ABSENT_EMPLOYEES_CAP = 5000;

/**
 * Whitelist cột sort cho danh sách NV vắng → fragment SQL an toàn (chống injection).
 * Key = sort_by param từ FE; chỉ các key này được phép, ngoài whitelist → fallback full_name.
 */
const ABSENT_ORDER_COLUMNS: Record<string, Prisma.Sql> = {
  employee_code: Prisma.sql`COALESCE(NULLIF(TRIM(e.employee_code), ''), 'NV' || LPAD(e.id::text, 4, '0'))`,
  full_name: Prisma.sql`u.full_name`,
  email: Prisma.sql`u.email`,
  phone: Prisma.sql`u.phone`,
  position: Prisma.sql`e.position`,
  department: Prisma.sql`e.department`,
  gender: Prisma.sql`e.gender`,
  office_name: Prisma.sql`ao.name`,
  team: Prisma.sql`mgr.full_name`,
};

/** Sort mặc định = theo Team (ưu tiên nhóm cùng team như Quản lý nhân viên). */
const ABSENT_DEFAULT_SORT = 'team';

/** Số liệu thô (đếm theo NGƯỜI distinct) cho 1 nhóm Team/Phòng ban trước khi derive tỉ lệ. */
type RawGroupStat = {
  headcount: number;
  checked_in_people: number;
  present_people: number;
  late_people: number;
  total_late_minutes: number;
};

/** 1 dòng thống kê chấm công theo Team (đếm theo NGƯỜI). */
export type TeamStatRow = RawGroupStat & {
  team_id: number | null;
  team_name: string;
  insufficient_people: number;
  absent_people: number;
  attendance_rate: number; // % (1 chữ số thập phân)
};

/** 1 dòng thống kê chấm công theo Phòng ban (kèm Trưởng phòng suy từ chức danh). */
export type DepartmentStatRow = RawGroupStat & {
  department: string;
  head_name: string | null;
  insufficient_people: number;
  absent_people: number;
  attendance_rate: number;
};

/**
 * 1 dòng CHI TIẾT NHÂN VIÊN trong kỳ (Sheet 2 của export theo Team/Phòng ban) — đếm theo
 * NGÀY, presence-based để đối soát được với Sheet 1 (đủ công = có cả vào+ra; thiếu công =
 * có vào, thiếu ra). Team resolve 3 tầng (đồng bộ Cài đặt → Team).
 */
export type EmployeeAttendanceSummaryRow = {
  employee_code: string;
  full_name: string | null;
  department: string;
  team_name: string;
  office_name: string;
  full_days: number;
  insufficient_days: number;
  late_days: number;
  total_late_minutes: number;
  leave_days: number;
  checked_in_days: number;
};

/** Số liệu "Về sớm" cho popup Thống kê (đơn early_leave + phút thiếu giờ). */
export type EarlyLeaveStats = {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  total_minutes: number;
  approval_rate: number; // % đơn được duyệt = approved / (approved + rejected)
  top_leavers: Array<{
    user_id: number;
    full_name: string | null;
    count: number;
    minutes: number;
  }>;
};

/** Tuỳ chọn cho 3 bộ lọc multi-select trong popup Thống kê chấm công. */
export type StatsFilterOptions = {
  departments: string[];
  teams: { id: number; name: string }[];
  offices: { id: number; name: string }[];
};

/** 1 dòng Top NV nghỉ nhiều nhất. */
export type DisciplineAbsentRow = {
  user_id: number;
  full_name: string | null;
  employee_code: string | null;
  team_name: string;
  position: string | null;
  absent_days: number;
  absent_occurrences: number; // số đợt vắng liên tiếp
  absent_rate: number; // % (1 chữ số thập phân)
};

/** 1 dòng Top NV đi muộn / về sớm nhiều nhất (đơn vị phút). */
export type DisciplineViolationRow = {
  user_id: number;
  full_name: string | null;
  employee_code: string | null;
  team_name: string;
  position: string | null;
  late_minutes: number;
  early_minutes: number;
  violation_minutes: number;
  late_count: number;
  early_count: number;
};

/** 1 nhóm giới tính (Nam/Nữ/Chưa xác định). */
export type DisciplineGenderRow = {
  gender: 'M' | 'F' | 'unknown';
  gender_label: string;
  headcount: number;
  total_absent_days: number;
  total_late_count: number;
  total_early_count: number;
  full_attendance_rate: number; // %
  insufficient_rate: number; // % = 100 - đủ công
};

/** Kết quả thống kê kỷ luật chấm công (3 khối). */
export type DisciplineStats = {
  date_from: string;
  date_to: string;
  work_end: string;
  total_workdays: number;
  top_absent: DisciplineAbsentRow[];
  top_violation: DisciplineViolationRow[];
  by_gender: DisciplineGenderRow[];
};

/** 1 lát cắt biểu đồ "Phân tích nghỉ phép" theo loại đơn (donut). */
export type LeaveTypeSlice = { type: string; label: string; value: number };

/** 1 lát cắt biểu đồ "Phân tích nghỉ phép" theo giới tính (donut). */
export type LeaveGenderSlice = {
  gender: 'M' | 'F' | 'unknown';
  label: string;
  value: number;
};

/** 1 tuần (block 7 ngày tính từ ngày bắt đầu) cho biểu đồ cột xếp chồng. */
export type LeaveWeekBucket = { label: string; from: string; to: string };

/** 1 phòng ban = 1 chuỗi xếp chồng; `values[]` khớp số tuần. */
export type LeaveDeptSeries = { department: string; values: number[] };

/**
 * Kết quả "Phân tích nghỉ phép" (4 biểu đồ trong popup Thống kê chấm công).
 * Bất biến: Σ by_type_days = Σ by_gender = Σ (mọi by_week values) (mỗi đơn approved = 1 "ngày").
 */
export type LeaveAnalytics = {
  date_from: string;
  date_to: string;
  by_type_days: LeaveTypeSlice[]; // đơn ĐÃ DUYỆT theo loại (chart 1)
  by_type_requests: LeaveTypeSlice[]; // TẤT CẢ đơn theo loại (chart 2)
  by_week: { weeks: LeaveWeekBucket[]; departments: LeaveDeptSeries[] }; // chart 3
  by_gender: LeaveGenderSlice[]; // đơn ĐÃ DUYỆT theo giới tính (chart 4)
};

/** Bản ghi tối thiểu để tính kỷ luật (recompute giờ/trạng thái tại chỗ). */
type DisciplineRec = {
  check_in_at: Date | null;
  check_out_at: Date | null;
  total_hours: number | null;
  status: string;
};

/** 1 ngày trong chuỗi thống kê (biểu đồ đường + summary lũy kế). */
type DailyStatRow = {
  day: string;
  checked_in: number;
  checked_out: number;
  complete: number;
  late: number;
  on_time: number;
  late_minutes: number;
};

/**
 * Resolve khoảng ngày cho thống kê (mặc định = tháng hiện tại, giờ VN).
 * Export để `attendance-stats-export.service` dựng phụ đề Excel khớp đúng kỳ.
 */
export function resolveStatsRange(dto: QueryAttendanceStatsDto): {
  fromStr: string;
  toStr: string;
} {
  const todayStr = getVnDateString();
  const [yy, mm] = todayStr.split('-');
  return {
    fromStr: dto.date_from ?? `${yy}-${mm}-01`,
    toStr: dto.date_to ?? todayStr,
  };
}

/**
 * Điều kiện RBAC scope theo Team (team_lead chỉ thấy subtree của mình). Tham chiếu alias `e`.
 * - `null` (super_admin/hr/kế toán) → KHÔNG giới hạn (trả null).
 * - `[]` (rỗng — role không có aggregate scope) → `1 = 0` (ẩn hết, KHÔNG leak).
 * - `[ids]` → `e.user_id IN (...)` parameterized.
 */
function buildScopeCondition(
  scopeUserIds?: number[] | null,
): Prisma.Sql | null {
  if (scopeUserIds == null) return null;
  return scopeUserIds.length
    ? Prisma.sql`e.user_id IN (${Prisma.join(scopeUserIds)})`
    : Prisma.sql`1 = 0`;
}

/**
 * Điều kiện roster "đang trong biên chế" tại mốc tham chiếu `refSql` — thay cho
 * `e.status = 'active'` trần. NV nghỉ việc (`status='resigned'`) vẫn được
 * TÍNH cho giai đoạn TRƯỚC ngày nghỉ (`resigned_at`, quy đổi giờ VN) — dữ liệu/thống kê lịch
 * sử KHÔNG bị xoá — nhưng bị LOẠI kể từ ngày nghỉ trở đi. Các status khác (on_leave/probation/
 * waiting...) vẫn bị loại như cũ (nhánh đầu `e.status = 'active'` GIỮ NGUYÊN).
 * `refSql`: cột SQL (`Prisma.raw('ar.work_date')`) hoặc tham số ngày đã parameterized
 * (`Prisma.sql\`${fromStr}::date\``) — CHỈ dùng `Prisma.raw` cho tên cột cố định, TUYỆT ĐỐI
 * KHÔNG cho giá trị người dùng.
 */
function employedRosterCond(refSql: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(e.status = 'active' OR (e.status = 'resigned' AND e.resigned_at IS NOT NULL AND (e.resigned_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > ${refSql}))`;
}

/** Mốc ngày hiện tại (giờ VN) — dùng làm `<REF>` cho roster KHÔNG có ngày trong scope
 *  (vd `getStatsFilterOptions`). Biểu thức SQL cố định — an toàn dùng `Prisma.raw`. */
const NOW_VN_DATE_SQL = Prisma.raw(`(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`);

// RESOLVED_TEAM_ID_SQL giờ import từ './attendance-org-sort.helper' (single
// source of truth, xem JSDoc tại đó) thay vì định nghĩa lại ở đây.

/** Sentinel "Chưa có team" trong filter `team_id[]` (id team luôn dương). */
const NO_TEAM_SENTINEL = -1;

/**
 * Fragment WHERE cho bộ lọc Phòng ban/Team/Văn phòng + RBAC scope — tham chiếu alias `e`
 * (employees) + `u` (users). Trả `AND <điều kiện>` để ghép sau WHERE; rỗng → `Prisma.empty`.
 * Tham số mảng đều parameterized (`Prisma.join`) → KHÔNG injection.
 */
function buildStatsEmpFilter(
  dto: QueryAttendanceStatsDto,
  scopeUserIds?: number[] | null,
): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  const scope = buildScopeCondition(scopeUserIds);
  if (scope) parts.push(scope);
  if (dto.department?.length) {
    parts.push(
      Prisma.sql`COALESCE(NULLIF(TRIM(e.department), ''), 'Chưa phân phòng') IN (${Prisma.join(dto.department)})`,
    );
  }
  if (dto.team_id?.length) {
    // Team CHÍNH THỨC (bảng teams) qua resolve 3 tầng — KHÔNG còn = u.manager_id.
    const realIds = dto.team_id.filter((id) => id !== NO_TEAM_SENTINEL);
    const conds: Prisma.Sql[] = [];
    if (realIds.length) {
      conds.push(Prisma.sql`${RESOLVED_TEAM_ID_SQL} IN (${Prisma.join(realIds)})`);
    }
    if (dto.team_id.includes(NO_TEAM_SENTINEL)) {
      conds.push(Prisma.sql`${RESOLVED_TEAM_ID_SQL} IS NULL`);
    }
    if (conds.length) {
      parts.push(
        conds.length === 1 ? conds[0] : Prisma.sql`(${Prisma.join(conds, ` OR `)})`,
      );
    }
  }
  if (dto.office_id?.length) {
    parts.push(Prisma.sql`e.office_id IN (${Prisma.join(dto.office_id)})`);
  }
  if (parts.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.join(parts, ` AND `)}`;
}

/** Bổ sung Chưa đủ công / Vắng / Tỷ lệ % từ số liệu thô (clamp ≥0, rate 1 chữ số thập phân). */
function deriveGroupStat<T extends RawGroupStat>(
  r: T,
): T & { insufficient_people: number; absent_people: number; attendance_rate: number } {
  const insufficient = Math.max(0, r.checked_in_people - r.present_people);
  const absent = Math.max(0, r.headcount - r.checked_in_people);
  const attendance_rate =
    r.headcount > 0
      ? Math.round((r.checked_in_people / r.headcount) * 1000) / 10
      : 0;
  return {
    ...r,
    insufficient_people: insufficient,
    absent_people: absent,
    attendance_rate,
  };
}

/** Cấu hình giới hạn đơn chấm công per-tháng */
type RequestConfig = {
  default_check_in: string;
  default_check_out: string;
  monthly_forgot_limit: number;
  monthly_late_early_limit: number;
};

const DEFAULT_REQUEST_CONFIG: RequestConfig = {
  default_check_in: '08:00',
  default_check_out: '17:30',
  monthly_forgot_limit: 2,
  monthly_late_early_limit: 3,
};

/**
 * Chuyển giờ VN "HH:MM" trên ngày UTC-midnight `workDate` sang UTC instant.
 * `work_date` lưu là UTC midnight của ngày VN (parseDateToUtcMidnight),
 * nên `getUTC*()` trả đúng năm/tháng/ngày VN. Trừ 7h để chuyển sang UTC.
 */
function vnTimeToInstant(workDate: Date, hm: string): Date {
  const [hStr, mStr] = hm.split(':');
  return new Date(
    Date.UTC(
      workDate.getUTCFullYear(),
      workDate.getUTCMonth(),
      workDate.getUTCDate(),
      Number(hStr) - 7,
      Number(mStr),
    ),
  );
}

/** Kiểu trả về của mapRequest */
export type AttendanceRequestDto = {
  id: number;
  user_id: number;
  user_name: string;
  work_date: string;
  type: string;
  requested_check_in: string | null;
  requested_check_out: string | null;
  reason: string;
  status: string;
  reviewed_by: number | null;
  reviewer_name: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  created_at: Date;
  /** Team CHÍNH THỨC của người gửi đơn — null = "Chưa có team". */
  team_name: string | null;
};

/** Chuyển "HH:MM" → số phút từ 00:00 */
function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** Trả chuỗi YYYY-MM-DD theo múi giờ VN (+07:00) */
function getVnDateString(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Chuyển YYYY-MM-DD thành Date UTC 00:00:00 (Prisma Date type) */
function parseDateToUtcMidnight(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Số phút nghỉ trưa rơi vào khoảng [checkIn, checkOut] — để TRỪ khỏi giờ làm.
 * Cửa sổ nghỉ trưa cấu hình theo giờ VN (HH:MM), neo vào NGÀY VN của checkIn.
 * VN = UTC+7 cố định (không DST) → dịch frame tính bằng số học thuần (không cần lib timezone).
 */
function calcLunchOverlapMinutes(
  checkIn: Date,
  checkOut: Date,
  lunchStart: string,
  lunchEnd: string,
): number {
  const startMin = hmToMinutes(lunchStart);
  const endMin = hmToMinutes(lunchEnd);
  if (endMin <= startMin) return 0; // cấu hình rỗng/không hợp lệ → không trừ
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  // Dịch sang frame VN (đọc getTime + offset như giờ tường VN) → lấy mốc đầu NGÀY VN.
  const dayStartVn = Math.floor((checkIn.getTime() + VN_OFFSET_MS) / 86_400_000) * 86_400_000;
  const lunchStartAbs = dayStartVn + startMin * 60_000 - VN_OFFSET_MS;
  const lunchEndAbs = dayStartVn + endMin * 60_000 - VN_OFFSET_MS;
  const overlapMs =
    Math.min(checkOut.getTime(), lunchEndAbs) - Math.max(checkIn.getTime(), lunchStartAbs);
  return overlapMs > 0 ? overlapMs / 60_000 : 0;
}

/** Tính total_hours từ check_in_at + check_out_at (trừ giờ nghỉ trưa nếu có) */
function calcTotalHours(
  checkIn: Date | null,
  checkOut: Date | null,
  lunch?: { start: string; end: string },
): number | null {
  if (!checkIn || !checkOut) return null;
  let diffMs = checkOut.getTime() - checkIn.getTime();
  if (diffMs <= 0) return null;
  if (lunch) {
    diffMs -= calcLunchOverlapMinutes(checkIn, checkOut, lunch.start, lunch.end) * 60_000;
  }
  if (diffMs <= 0) return 0; // làm trọn trong giờ nghỉ trưa → 0 giờ
  return Math.round((diffMs / 3_600_000) * 100) / 100;
}

/** Số phút đi muộn so với mốc cấu hình (lateAfterMinutes = phút từ 00:00, giờ VN) */
function calcLateMinutes(checkIn: Date | null, lateAfterMinutes: number): number {
  if (!checkIn) return 0;
  const local = new Date(checkIn.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const minutesPast = local.getHours() * 60 + local.getMinutes();
  return minutesPast > lateAfterMinutes ? minutesPast - lateAfterMinutes : 0;
}

/** Số phút từ 00:00 theo giờ VN của 1 mốc thời gian (giờ tan ca / giờ ra). */
function vnClockMinutes(d: Date): number {
  const local = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  return local.getHours() * 60 + local.getMinutes();
}

/**
 * Chia [fromStr, toStr] thành các block 7 ngày liên tiếp tính từ fromStr → "Tuần 1..N".
 * 1 tháng đủ → W1–W5. Robust cho mọi khoảng (kể cả tuỳ chỉnh). Toán UTC thuần
 * (work_date lưu UTC-midnight của ngày VN nên index tuần = floor(Δngày / 7) chuẩn xác).
 */
export function buildLeaveWeekBuckets(
  fromStr: string,
  toStr: string,
): LeaveWeekBucket[] {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  if (toUtc < fromUtc) return [];
  const totalDays = Math.floor((toUtc - fromUtc) / 86_400_000) + 1;
  const weekCount = Math.ceil(totalDays / 7);
  const fmt = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const out: LeaveWeekBucket[] = [];
  for (let i = 0; i < weekCount; i++) {
    const startMs = fromUtc + i * 7 * 86_400_000;
    const endMs = Math.min(startMs + 6 * 86_400_000, toUtc);
    out.push({ label: `Tuần ${i + 1}`, from: fmt(startMs), to: fmt(endMs) });
  }
  return out;
}

/**
 * Danh sách ngày làm việc YYYY-MM-DD trong [fromStr, toStr]: T2–T6 + các Thứ 7 nằm trong
 * `workingSaturdays`. CN luôn nghỉ. Toán UTC thuần (work_date lưu UTC-midnight của ngày VN).
 */
export function buildWorkdayList(
  fromStr: string,
  toStr: string,
  workingSaturdays: Set<string>,
): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  let cur = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (cur <= end) {
    const dt = new Date(cur);
    const dow = dt.getUTCDay(); // 0=CN .. 6=T7
    const ds = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    const isWorkday =
      dow >= 1 && dow <= 5 ? true : dow === 6 ? workingSaturdays.has(ds) : false;
    if (isWorkday) out.push(ds);
    cur += 86_400_000;
  }
  return out;
}

/** Tính trạng thái dựa trên giờ check-in VN + mốc đi muộn cấu hình */
function calcStatus(
  checkIn: Date | null,
  checkOut: Date | null,
  lunch?: { start: string; end: string },
  reviewMaxHours = 1,
  halfDayMinHours = 4,
  fullDayMinHours = 8,
): string {
  if (!checkIn) return 'incomplete';
  if (!checkOut) return 'incomplete';
  const hours = calcTotalHours(checkIn, checkOut, lunch) ?? 0;
  // Trạng thái CHỈ theo GIỜ: đủ full_day_min giờ → 'present' (đủ công)
  // KỂ CẢ khi đi muộn. Đi muộn / đúng giờ KHÔNG nằm trong status — thể hiện qua `late_minutes`
  // (cột Ghi chú). Ngưỡng CẤU HÌNH (Setting attendance_shift_config), 4 bậc:
  // < review_max → 'review' (Xem xét); [review_max, half_day_min) → 'insufficient' (Chưa đủ
  // nửa ngày); [half_day_min, full_day_min) → 'half_day' (Nửa ngày); >= full_day_min → 'present'.
  if (hours < reviewMaxHours) return 'review';
  if (hours < halfDayMinHours) return 'insufficient';
  if (hours < fullDayMinHours) return 'half_day';
  return 'present';
}

/**
 * Trạng thái HIỂN THỊ — TÍNH LẠI từ giờ chấm + cấu hình, KHÔNG tin `status` lưu DB.
 * Lý do: status lưu DB được tính lúc check-out theo logic/ngưỡng tại thời điểm đó → STALE
 * khi đổi logic (review) hoặc đổi ngưỡng cấu hình. `leave`/`maternity` do DUYỆT ĐƠN set,
 * không suy ra từ giờ → GIỮ NGUYÊN.
 */
export function displayStatus(
  record: { check_in_at: Date | null; check_out_at: Date | null; status: string },
  cfg: ShiftConfig,
): string {
  if (record.status === 'leave' || record.status === 'maternity') return record.status;
  return calcStatus(
    record.check_in_at,
    record.check_out_at,
    { start: cfg.lunch_start, end: cfg.lunch_end },
    cfg.review_max_hours,
    cfg.half_day_min_hours,
    cfg.full_day_min_hours,
  );
}

/**
 * Tổng giờ làm HIỂN THỊ — TÍNH LẠI từ giờ chấm + giờ nghỉ trưa cấu hình, KHÔNG tin
 * `total_hours` lưu DB (stale khi: bản ghi chấm RA trước khi bật trừ nghỉ trưa, hoặc
 * admin đổi cấu hình nghỉ trưa sau đó). Mirror `displayStatus` để hiển thị nhất quán mọi nơi:
 *   - leave/maternity: GIỮ NGUYÊN total_hours lưu DB (do duyệt đơn set = 8h; check_in/out chỉ
 *     là mốc tượng trưng 08:00–17:30 → KHÔNG suy lại từ giờ, nếu không sẽ ra 7.5h sai).
 *   - còn lại: recompute từ check_in_at/check_out_at (trừ phần giao nghỉ trưa).
 */
export function displayTotalHours(
  record: {
    check_in_at: Date | null;
    check_out_at: Date | null;
    total_hours: number | null;
    status: string;
  },
  cfg: ShiftConfig,
): number | null {
  if (record.status === 'leave' || record.status === 'maternity') {
    return record.total_hours;
  }
  return calcTotalHours(record.check_in_at, record.check_out_at, {
    start: cfg.lunch_start,
    end: cfg.lunch_end,
  });
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly notifications: NotificationsService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * Owner ids THẬT theo quyền `perm` (own/team/subtree → mảng user_id; all →
   * chuỗi `'all'`) — nguồn DUY NHẤT cho scope dữ liệu chấm công cá nhân (sổ
   * chấm công/chi tiết/ảnh selfie/export thường). KHÁC `resolveStatsScope`
   * (dùng cho `/stats/*`, quy ước `null`=all) — 2 quy ước khác nhau CÓ CHỦ Ý,
   * `scopeWhere`/`assertInScope`/`intersectUserIdFilter` đều nhận `'all'`.
   *
   * Actor có scope `team`/`subtree` chỉ thấy bản ghi + ảnh selfie trong phạm vi của mình.
   */
  async resolveOwnerIds(
    user: AuthUser,
    perm: 'attendance.view' | 'attendance.export' | 'attendance.manage',
  ): Promise<number[] | 'all'> {
    const owner = await this.scope.ownerIds(user, perm);
    // Controller đã gác `@Can(perm)` trước khi tới đây nên `null` (không có
    // quyền) không nên xảy ra — fail-closed về `[]` (0 dòng) thay vì `'all'`
    // nếu vẫn lọt qua (an toàn hơn là im lặng mở rộng phạm vi).
    return owner ?? [];
  }

  /**
   * Upload ảnh selfie lên MinIO, trả về object key.
   * Key: attendance/<userId>/<YYYY-MM-DD VN>/<slot>_<ts>.<ext> — ext lấy từ MIME (chống path traversal).
   */
  private async uploadSelfie(
    userId: number,
    vnDateStr: string,
    slot: 'in' | 'out',
    selfie: Express.Multer.File,
  ): Promise<string> {
    const ext = SELFIE_MIME_EXT[selfie.mimetype] ?? 'jpg';
    const key = `attendance/${userId}/${vnDateStr}/${slot}_${Date.now()}.${ext}`;
    await this.storageService.upload(key, selfie.buffer, selfie.mimetype);
    return key;
  }

  /**
   * Ghi DB sau khi upload ảnh selfie; nếu DB write fail → xoá ảnh vừa upload để tránh
   * object mồ côi trên MinIO (ảnh tồn tại mà không record nào trỏ tới). Best-effort delete,
   * KHÔNG nuốt lỗi DB gốc (vẫn re-throw để caller trả lỗi đúng).
   */
  private async persistWithProofCleanup<T>(
    proofKey: string,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (err) {
      runInBackground(() => this.storageService.delete(proofKey));
      throw err;
    }
  }

  // ============================================================
  // CHECK-IN / CHECK-OUT (IP + Device Token)
  // ============================================================

  /**
   * Tìm văn phòng hợp lệ cho IP theo VĂN PHÒNG ĐƯỢC GÁN (office_id) của nhân viên.
   * - Có gán VP (office_id, VP thật đang hoạt động): CHỈ chấp nhận IP khớp đúng VP đó.
   * - Chưa gán VP (null) / VP gán không còn hoạt động: chấp nhận IP của BẤT KỲ VP thật
   *   nào (fallback — tránh khoá nhân viên chưa cấu hình).
   * - Quản trị viên hệ thống: không khớp → cho qua VP demo (bỏ kiểm tra IP để dùng thử từ xa).
   * Không khớp → ném BadRequestException (thông báo theo ngữ cảnh có/không gán VP).
   */
  private async resolveOfficeForCheck(
    clientIp: string,
    officeId: number | null,
    isSuperAdmin: boolean,
  ): Promise<{ id: number; name: string; ips: string[]; is_demo: boolean }> {
    const offices = await this.prisma.attendanceOffice.findMany({
      where: { is_active: true },
      select: { id: true, name: true, ips: true, is_demo: true },
    });
    const realOffices = offices.filter((o) => !o.is_demo);
    // VP được gán — chỉ tính VP thật đang hoạt động.
    const assignedOffice =
      officeId != null ? realOffices.find((o) => o.id === officeId) : undefined;

    let matched: (typeof offices)[number] | undefined;
    if (assignedOffice) {
      // Siết: chỉ chấm ở ĐÚNG văn phòng được gán.
      if (ipMatchesOffice(clientIp, assignedOffice.ips)) matched = assignedOffice;
    } else {
      // Chưa gán (hoặc VP gán không còn hoạt động) → cho chấm ở mọi VP thật.
      matched = realOffices.find((o) => ipMatchesOffice(clientIp, o.ips));
    }

    // super_admin: không khớp VP thật → qua VP demo (bỏ kiểm tra IP để test từ xa).
    if (!matched && isSuperAdmin) {
      matched = offices.find((o) => o.is_demo);
    }

    if (!matched) {
      if (assignedOffice) {
        throw new BadRequestException(
          `IP ${clientIp} không khớp văn phòng "${assignedOffice.name}" được phân công cho bạn. Vui lòng chấm công tại văn phòng của mình.`,
        );
      }
      throw new BadRequestException(
        `IP ${clientIp} không thuộc văn phòng nào đang hoạt động. Vui lòng chấm công trong mạng nội bộ văn phòng.`,
      );
    }
    return matched;
  }

  /**
   * Chấm công vào — xác thực IP ĐÚNG VĂN PHÒNG ĐƯỢC GÁN + ảnh selfie BẮT BUỘC.
   * (Đã bỏ kiểm tra thiết bị — IP văn phòng + selfie đã đủ chống gian lận.)
   */
  async checkIn(
    userId: number,
    deviceId: string,
    req: Request,
    note?: string,
    selfie?: Express.Multer.File,
    isSuperAdmin = false,
  ) {
    const clientIp = extractClientIp(req);
    if (!clientIp) {
      throw new BadRequestException('Không xác định được địa chỉ IP của thiết bị.');
    }

    // 1. Load employee — cần office_id để xác định VĂN PHÒNG ĐƯỢC GÁN được phép chấm.
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: userId },
      select: { id: true, office_id: true },
    });
    if (!employee) {
      throw new BadRequestException('Chưa có hồ sơ nhân viên. Liên hệ quản trị viên.');
    }

    // 2. Validate IP — CHỈ chấp nhận đúng văn phòng được gán cho nhân viên (office_id).
    //    Chưa gán → mọi VP thật; super_admin → fallback VP demo.
    const matchedOffice = await this.resolveOfficeForCheck(
      clientIp,
      employee.office_id,
      isSuperAdmin,
    );

    const now = new Date();
    const vnDateStr = getVnDateString(now);
    const workDate = parseDateToUtcMidnight(vnDateStr);

    // 3. Idempotent: đã check-in hôm nay → trả về ngay (KHÔNG yêu cầu selfie).
    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { user_id_work_date: { user_id: userId, work_date: workDate } },
    });
    if (existing?.check_in_at) {
      return { record: existing, already: true, office: matchedOffice.name };
    }

    // 4. Ảnh selfie BẮT BUỘC.
    if (!selfie) {
      throw new BadRequestException('Vui lòng chụp ảnh selfie để chấm công vào.');
    }

    // 5. Tính số phút đi muộn NGAY khi check-in — record chỉ có check-in,
    // chưa check-out, vẫn phải lưu late_minutes đúng (trước đây chỉ tính ở check-out → hiện 0p).
    const lateAfterMinutes = await this.resolveLateAfterMinutes();
    const lateMinutes = calcLateMinutes(now, lateAfterMinutes);

    // 6. Upload ảnh selfie lên MinIO (fail → throw, KHÔNG ghi chấm công thiếu ảnh)
    const proofKey = await this.uploadSelfie(userId, vnDateStr, 'in', selfie);

    // 7. Upsert record — DB UNIQUE(user_id, work_date) là backstop. persistWithProofCleanup
    // xoá ảnh selfie nếu DB write fail (tránh object mồ côi trên MinIO).
    const record = await this.persistWithProofCleanup(proofKey, () =>
      this.prisma.attendanceRecord.upsert({
        where: { user_id_work_date: { user_id: userId, work_date: workDate } },
        create: {
          user_id: userId,
          employee_id: employee.id,
          work_date: workDate,
          check_in_at: now,
          check_in_ip: clientIp,
          check_in_office_id: matchedOffice.id,
          device_id: deviceId,
          check_in_note: note ?? null,
          check_in_proof_key: proofKey,
          late_minutes: lateMinutes,
          status: 'incomplete',
        },
        update: {
          check_in_at: now,
          check_in_ip: clientIp,
          check_in_office_id: matchedOffice.id,
          device_id: deviceId,
          check_in_note: note ?? null,
          check_in_proof_key: proofKey,
          late_minutes: lateMinutes,
          status: 'incomplete',
        },
      }),
    );

    this.logger.log(
      `User ${userId} checked in at ${now.toISOString()} from IP ${clientIp} (${matchedOffice.name})`,
    );
    return { record, already: false, office: matchedOffice.name };
  }

  /**
   * Chấm công ra — xác thực IP ĐÚNG VĂN PHÒNG ĐƯỢC GÁN + ảnh selfie BẮT BUỘC.
   * (Đã bỏ kiểm tra thiết bị.)
   */
  async checkOut(
    userId: number,
    _deviceId: string,
    req: Request,
    note?: string,
    selfie?: Express.Multer.File,
    isSuperAdmin = false,
  ) {
    const clientIp = extractClientIp(req);
    if (!clientIp) {
      throw new BadRequestException('Không xác định được địa chỉ IP của thiết bị.');
    }

    // 1. Load employee — cần office_id để xác định VĂN PHÒNG ĐƯỢC GÁN được phép chấm.
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: userId },
      select: { id: true, office_id: true },
    });
    if (!employee) {
      throw new BadRequestException('Chưa có hồ sơ nhân viên. Liên hệ quản trị viên.');
    }

    // 2. Validate IP — CHỈ chấp nhận đúng văn phòng được gán (office_id). Chưa gán → mọi VP
    //    thật; super_admin → fallback VP demo. (Đã bỏ kiểm tra thiết bị.)
    const matchedOffice = await this.resolveOfficeForCheck(
      clientIp,
      employee.office_id,
      isSuperAdmin,
    );

    const now = new Date();
    const vnDateStr = getVnDateString(now);
    const workDate = parseDateToUtcMidnight(vnDateStr);
    // Lấy cả config ca làm — cần late_after + giờ nghỉ trưa cho total_hours.
    const shiftConfig = await this.getShiftConfig();
    const lateAfterMinutes = hmToMinutes(shiftConfig.late_after);
    const lunchWindow = { start: shiftConfig.lunch_start, end: shiftConfig.lunch_end };

    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { user_id_work_date: { user_id: userId, work_date: workDate } },
    });
    if (!existing?.check_in_at) {
      throw new BadRequestException('Chưa có check-in hôm nay, không thể check-out.');
    }
    if (existing.check_out_at) {
      return { record: existing, already: true, office: matchedOffice.name };
    }

    // Ảnh selfie BẮT BUỘC (sau nhánh đã-check-out để double-click không bị 400 + không tạo ảnh mồ côi)
    if (!selfie) {
      throw new BadRequestException('Vui lòng chụp ảnh selfie để chấm công ra.');
    }
    const proofKey = await this.uploadSelfie(userId, vnDateStr, 'out', selfie);

    const checkInAt = existing.check_in_at;
    const totalHours = calcTotalHours(checkInAt, now, lunchWindow);
    const lateMinutes = calcLateMinutes(checkInAt, lateAfterMinutes);
    const status = calcStatus(
      checkInAt,
      now,
      lunchWindow,
      shiftConfig.review_max_hours,
      shiftConfig.half_day_min_hours,
      shiftConfig.full_day_min_hours,
    );

    const record = await this.persistWithProofCleanup(proofKey, () =>
      this.prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: {
          check_out_at: now,
          check_out_ip: clientIp,
          check_out_office_id: matchedOffice.id,
          check_out_note: note ?? null,
          check_out_proof_key: proofKey,
          total_hours: totalHours ?? undefined,
          late_minutes: lateMinutes,
          status,
          updated_at: now,
        },
      }),
    );

    this.logger.log(
      `User ${userId} checked out at ${now.toISOString()} from IP ${clientIp} (${matchedOffice.name})`,
    );
    return { record, already: false, office: matchedOffice.name };
  }

  // ============================================================
  // OFFICE MANAGEMENT
  // ============================================================

  async listOffices() {
    return this.prisma.attendanceOffice.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async createOffice(dto: CreateOfficeDto) {
    return this.prisma.attendanceOffice.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        ips: dto.ips,
        is_active: dto.is_active ?? true,
        is_demo: dto.is_demo ?? false,
      },
    });
  }

  async updateOffice(id: number, dto: UpdateOfficeDto) {
    const office = await this.prisma.attendanceOffice.findUnique({ where: { id } });
    if (!office) throw new NotFoundException('Không tìm thấy văn phòng.');

    const updateData: Record<string, unknown> = {};
    if (dto.name !== undefined) updateData['name'] = dto.name;
    if (dto.description !== undefined) updateData['description'] = dto.description;
    if (dto.ips !== undefined) updateData['ips'] = dto.ips;
    if (dto.is_active !== undefined) updateData['is_active'] = dto.is_active;
    if (dto.is_demo !== undefined) updateData['is_demo'] = dto.is_demo;

    return this.prisma.attendanceOffice.update({ where: { id }, data: updateData });
  }

  async deleteOffice(id: number) {
    const office = await this.prisma.attendanceOffice.findUnique({ where: { id } });
    if (!office) throw new NotFoundException('Không tìm thấy văn phòng.');
    await this.prisma.attendanceOffice.delete({ where: { id } });
    return { ok: true };
  }

  // ============================================================
  // RESET DEVICE (super_admin only)
  // ============================================================

  async resetDevice(employeeUserId: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
      select: { id: true, registered_device_id: true },
    });
    if (!employee) throw new NotFoundException('Không tìm thấy hồ sơ nhân viên.');

    await this.prisma.employee.update({
      where: { user_id: employeeUserId },
      data: { registered_device_id: null, device_registered_at: null },
    });

    this.logger.log(`Device reset for user ${employeeUserId} (was: ${employee.registered_device_id ?? 'null'})`);
    return { ok: true, user_id: employeeUserId };
  }

  // ============================================================
  // DANH SÁCH + SỔ CHẤM CÔNG
  // ============================================================

  /** Tóm tắt hôm nay (admin = super_admin/hr: đếm tổng; user thường: bản ghi của mình) */
  async getTodaySummary(userId: number, isAdmin: boolean, dto: QueryTodaySummaryDto) {
    const dateStr = dto.date ?? getVnDateString();
    const workDate = parseDateToUtcMidnight(dateStr);

    if (isAdmin) {
      const [totalEmployees, checkedIn, present, incomplete] = await Promise.all([
        this.prisma.user.count({ where: { deleted_at: null, status: 'active' } }),
        this.prisma.attendanceRecord.count({
          where: { work_date: workDate, check_in_at: { not: null } },
        }),
        this.prisma.attendanceRecord.count({
          where: { work_date: workDate, check_in_at: { not: null }, status: { not: 'incomplete' } },
        }),
        this.prisma.attendanceRecord.count({
          where: { work_date: workDate, status: 'incomplete', check_in_at: { not: null } },
        }),
      ]);
      return {
        work_date: dateStr,
        total: totalEmployees,
        checked_in: checkedIn,
        present,
        incomplete,
        absent: Math.max(0, totalEmployees - checkedIn),
      };
    }

    const record = await this.prisma.attendanceRecord.findUnique({
      where: { user_id_work_date: { user_id: userId, work_date: workDate } },
    });
    if (!record) return { work_date: dateStr, record: null };
    // TÍNH LẠI status + total_hours khi hiển thị (KHÔNG tin giá trị lưu DB — stale: total_hours
    // chưa trừ nghỉ trưa nếu chấm ra trước khi bật).
    const shiftConfig = await this.getShiftConfig();
    return {
      work_date: dateStr,
      record: {
        ...record,
        status: displayStatus(record, shiftConfig),
        total_hours: displayTotalHours(record, shiftConfig),
      },
    };
  }

  /**
   * Bảng chấm công tháng (lưới NV × ngày).
   * Trả mỗi nhân viên 1 MatrixRow gồm DayCell cho từng ngày + tổng kết.
   */
  async getWorkdaysMatrix(dto: QueryAttendanceDto, ownerIds: number[] | 'all') {
    const where: Record<string, unknown> = {};
    if (dto.date_from) {
      where['work_date'] = {
        ...(where['work_date'] as object),
        gte: parseDateToUtcMidnight(dto.date_from),
      };
    }
    if (dto.date_to) {
      where['work_date'] = {
        ...(where['work_date'] as object),
        lte: parseDateToUtcMidnight(dto.date_to),
      };
    }
    if (ownerIds === 'all') {
      if (dto.user_id) where['user_id'] = dto.user_id;
    } else {
      where['user_id'] = intersectUserIdFilter(dto.user_id, ownerIds);
    }

    // lọc theo Team / Phòng ban / Chức danh qua employee relation
    // (giống listRecords). Team_id KHÔNG lọc trực tiếp cột thô `employees.team_id`
    // (đa số NV có Team qua tầng 2/3 — trưởng nhóm/quản lý — KHÔNG gán trực tiếp,
    // filter thô luôn trả rỗng) — resolve 3 tầng qua `resolveTeamMemberUserIds`
    // rồi giao với `where.user_id` đã có (IDOR/self-scope) bằng `intersectUserIdFilter`.
    const matrixEmployeeWhere: Record<string, unknown> = {};
    if (dto.department?.trim()) matrixEmployeeWhere['department'] = dto.department.trim();
    if (dto.job_title_id) matrixEmployeeWhere['job_title_id'] = dto.job_title_id;
    if (Object.keys(matrixEmployeeWhere).length > 0) {
      where['user'] = { employee: matrixEmployeeWhere };
    }
    if (dto.team_id) {
      const teamUserIds = await resolveTeamMemberUserIds(this.prisma, dto.team_id);
      where['user_id'] = intersectUserIdFilter(where['user_id'], teamUserIds);
    }

    const shiftConfig = await this.getShiftConfig();
    const lateAfterMinutes = hmToMinutes(shiftConfig.late_after);

    const records = await this.prisma.attendanceRecord.findMany({
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
                employee_code: true,
                department: true,
                team_id: true,
              },
            },
          },
        },
      },
      // orderBy bắt buộc: khi chạm cap MATRIX_RECORD_CAP, findMany không orderBy
      // sẽ truncate NGẪU NHIÊN theo execution plan → bỏ sót NV không xác định.
      orderBy: [{ user_id: 'asc' }, { work_date: 'asc' }],
      take: MATRIX_RECORD_CAP,
    });

    // Team CHÍNH THỨC (resolve 3 tầng) cho cột "Team" — mirror listRecords/exportToExcel.
    const orgLookup = await loadTeamOrgLookup(this.prisma);

    // Đơn "Xin về sớm" trong kỳ (suy ra động — KHÔNG ghi đè bản ghi, giữ giờ thực tế để đối soát).
    // Nguồn sự thật = attendance_requests.status. Ngày half_day có đơn approved → bù thành đủ công.
    const elWhere: Prisma.AttendanceRequestWhereInput = { type: 'early_leave' };
    if (where['work_date']) {
      elWhere.work_date = where['work_date'] as Prisma.DateTimeFilter;
    }
    if (dto.user_id) elWhere.user_id = dto.user_id;
    const earlyLeaveReqs = await this.prisma.attendanceRequest.findMany({
      where: elWhere,
      select: { user_id: true, work_date: true, status: true },
    });
    // Set keyed "user_id:YYYY-MM-DD" + đếm theo NV (tổng / approved / rejected).
    const elApprovedDates = new Set<string>();
    const elAnyDates = new Set<string>();
    const elCounts = new Map<
      number,
      { total: number; approved: number; rejected: number }
    >();
    for (const er of earlyLeaveReqs) {
      const k = `${er.user_id}:${er.work_date.toISOString().slice(0, 10)}`;
      elAnyDates.add(k);
      if (er.status === 'approved') elApprovedDates.add(k);
      const c = elCounts.get(er.user_id) ?? { total: 0, approved: 0, rejected: 0 };
      c.total += 1;
      if (er.status === 'approved') c.approved += 1;
      else if (er.status === 'rejected') c.rejected += 1;
      elCounts.set(er.user_id, c);
    }
    const fullDayMinutes = shiftConfig.full_day_min_hours * 60;

    const map = new Map<number, MatrixRow>();

    for (const r of records) {
      let row = map.get(r.user_id);
      if (!row) {
        row = {
          user_id: r.user_id,
          full_name: r.user?.full_name ?? null,
          email: r.user?.email ?? null,
          employee_code: r.user?.employee?.employee_code ?? null,
          position: r.user?.employee?.position ?? null,
          department: r.user?.employee?.department ?? null,
          team_name: resolveTeamName(r.user as OrgUserLite | null, orgLookup),
          total_work_days: 0,
          total_work_days_after_approval: 0,
          total_hours: 0,
          present_days: 0,
          half_days: 0,
          insufficient_days: 0,
          incomplete_days: 0,
          leave_days: 0,
          maternity_days: 0,
          late_days: 0,
          total_late_minutes: 0,
          early_leave_count: 0,
          early_leave_approved: 0,
          early_leave_rejected: 0,
          early_leave_minutes: 0,
          compensated_days: 0,
          notes: '',
          cells: {} as Record<number, DayCell>,
        };
        map.set(r.user_id, row);
      }

      const status = displayStatus(r, shiftConfig);
      // displayTotalHours: non-leave recompute (trừ nghỉ trưa); leave/maternity GIỮ 8h lưu DB
      // (KHÔNG suy lại từ mốc 08:00–17:30 tượng trưng → tránh ra 7.5h sai).
      const hours = displayTotalHours(r, shiftConfig) ?? null;
      const late = calcLateMinutes(r.check_in_at, lateAfterMinutes);
      const dayNum = r.work_date.getUTCDate();

      // Overlay đơn về sớm: ngày half_day (4–8h) có đơn DUYỆT → bù thành đủ công (+0.5 ở .map).
      const dateKey = `${r.user_id}:${r.work_date.toISOString().slice(0, 10)}`;
      const compensated = status === 'half_day' && elApprovedDates.has(dateKey);
      if (compensated) row.compensated_days += 1;
      // Phút về sớm = thiếu so với đủ công (8h), tính trên MỌI ngày có đơn về sớm + thiếu giờ.
      if (elAnyDates.has(dateKey) && hours != null && hours * 60 < fullDayMinutes) {
        row.early_leave_minutes += Math.round(fullDayMinutes - hours * 60);
      }

      row.cells[dayNum] = {
        day: dayNum,
        status,
        hours,
        late_minutes: late,
        check_in: vnHhmm(r.check_in_at),
        check_out: vnHhmm(r.check_out_at),
        early_leave_compensated: compensated,
      };

      row.total_hours += hours ?? 0;
      if (late > 0) {
        row.late_days += 1;
        row.total_late_minutes += late;
      }
      switch (status) {
        case 'present':
          row.present_days += 1;
          break;
        case 'half_day':
          row.half_days += 1;
          break;
        case 'insufficient':
        case 'review':
          row.insufficient_days += 1;
          break;
        case 'incomplete':
          row.incomplete_days += 1;
          break;
        case 'leave':
          row.leave_days += 1;
          break;
        case 'maternity':
          row.maternity_days += 1;
          break;
      }
    }

    const rows = Array.from(map.values()).map((row) => {
      const rounded = Math.round(row.total_hours * 100) / 100;
      const totalWorkDays =
        row.present_days + row.leave_days + row.maternity_days + 0.5 * row.half_days;
      // Mỗi ngày half_day được bù (đơn về sớm duyệt) lên 0.5 → 1.0, tức +0.5 mỗi ngày.
      const afterApproval = totalWorkDays + 0.5 * row.compensated_days;
      const counts = elCounts.get(row.user_id) ?? {
        total: 0,
        approved: 0,
        rejected: 0,
      };
      return {
        ...row,
        total_hours: rounded,
        total_work_days: Math.round(totalWorkDays * 10) / 10,
        total_work_days_after_approval: Math.round(afterApproval * 10) / 10,
        early_leave_count: counts.total,
        early_leave_approved: counts.approved,
        early_leave_rejected: counts.rejected,
        notes: computeNotes(row),
      };
    });

    rows.sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '', 'vi'));

    const daysInMonth = dto.date_from
      ? daysInMonthFromDateFrom(dto.date_from)
      : dto.date_to
        ? daysInMonthFromDateFrom(dto.date_to)
        : 31;

    return {
      date_from: dto.date_from ?? null,
      date_to: dto.date_to ?? null,
      days_in_month: daysInMonth,
      count: rows.length,
      capped: records.length >= MATRIX_RECORD_CAP,
      rows,
    };
  }

  /**
   * Sổ chấm công có phân trang + filter — scope THẬT theo `attendance.view`
   * (`ownerIds`: `'all'` hoặc mảng user_id theo own/team/subtree). Bản ghi
   * của chính actor LUÔN nằm trong mảng vì scope tối thiểu là `own` (chính
   * mình) — KHÔNG cần nhánh đặc cách riêng.
   */
  async listRecords(userId: number, ownerIds: number[] | 'all', dto: QueryAttendanceDto) {
    const page = dto.page ?? 1;
    const pageSize = dto.page_size ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Record<string, unknown> = {};
    if (dto.date_from) {
      where['work_date'] = { ...(where['work_date'] as object), gte: parseDateToUtcMidnight(dto.date_from) };
    }
    if (dto.date_to) {
      where['work_date'] = { ...(where['work_date'] as object), lte: parseDateToUtcMidnight(dto.date_to) };
    }
    if (ownerIds === 'all') {
      if (dto.user_id) where['user_id'] = dto.user_id;
    } else {
      // Giao (AND) filter user_id do client gửi (nếu có) với phạm vi scope thật
      // KHÔNG spread/ghi đè: dto.user_id ngoài scope → -1 (0 dòng, không leak).
      where['user_id'] = intersectUserIdFilter(dto.user_id, ownerIds);
    }
    // tìm theo tên nhân viên (ILIKE). Non-admin chỉ có data của mình nên vô hại.
    // thêm bộ lọc Team/Phòng ban/Chức danh qua employee relation.
    // Team_id KHÔNG lọc trực tiếp cột thô `employees.team_id` (đa số NV có Team
    // qua tầng 2/3 — trưởng nhóm/quản lý — KHÔNG gán trực tiếp, filter thô luôn
    // trả rỗng) — resolve 3 tầng rồi giao (AND) với `where.user_id`
    // đã có (IDOR self-scope / dto.user_id) qua `intersectUserIdFilter`.
    const userWhere: Record<string, unknown> = {};
    if (dto.search?.trim()) {
      userWhere['full_name'] = { contains: dto.search.trim(), mode: 'insensitive' };
    }
    const employeeWhere: Record<string, unknown> = {};
    if (dto.department?.trim()) {
      employeeWhere['department'] = dto.department.trim();
    }
    if (dto.job_title_id) {
      employeeWhere['job_title_id'] = dto.job_title_id;
    }
    if (Object.keys(employeeWhere).length > 0) {
      userWhere['employee'] = employeeWhere;
    }
    if (Object.keys(userWhere).length > 0) {
      where['user'] = userWhere;
    }
    if (dto.team_id) {
      const teamUserIds = await resolveTeamMemberUserIds(this.prisma, dto.team_id);
      where['user_id'] = intersectUserIdFilter(where['user_id'], teamUserIds);
    }

    // Sắp xếp đa cột — mặc định check_in asc (ai chấm VÀO sớm nhất lên đầu).
    // Cột thời gian/giờ dùng nulls:'last' để bản ghi chưa chấm xuống cuối. id chốt thứ tự ổn định cho phân trang.
    const sortDir: 'asc' | 'desc' = dto.sort_dir === 'desc' ? 'desc' : 'asc';
    const nullsLast = { sort: sortDir, nulls: 'last' } as const;
    // "org" sắp theo sơ đồ tổ chức — tính ở app-layer (compareByOrgOrder), KHÔNG có
    // orderBy DB tương ứng (team_name là giá trị resolve 3 tầng, không phải cột thật).
    const isOrgSort = dto.sort_by === 'org';
    let primary: Prisma.AttendanceRecordOrderByWithRelationInput;
    switch (dto.sort_by) {
      case 'work_date':
        primary = { work_date: sortDir };
        break;
      case 'employee':
        primary = { user: { full_name: sortDir } };
        break;
      case 'check_out':
        primary = { check_out_at: nullsLast };
        break;
      case 'total_hours':
        primary = { total_hours: nullsLast };
        break;
      case 'status':
        primary = { status: sortDir };
        break;
      case 'org':
      case 'check_in':
      default:
        primary = { check_in_at: nullsLast };
        break;
    }
    const orderBy: Prisma.AttendanceRecordOrderByWithRelationInput[] = [
      primary,
      { id: 'asc' },
    ];

    // employee.team_id/department/jobTitle.sort_order + user.manager_id — cần để
    // resolve Team CHÍNH THỨC (3 tầng) + rank chức danh cho cột Team/Phòng ban + sort "org".
    const include = {
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
    };

    // Tính LẠI late_minutes + status từ giờ chấm (KHÔNG tin giá trị lưu DB — có thể STALE:
    // late_minutes NULL khi chưa chấm ra; status tính lúc check-out theo ngưỡng cũ). leave/
    // maternity giữ nguyên (do duyệt đơn set).
    const shiftConfig = await this.getShiftConfig();
    const lateAfterMinutes = hmToMinutes(shiftConfig.late_after);
    const orgLookup = await loadTeamOrgLookup(this.prisma);

    type RecordWithOrgUser = Prisma.AttendanceRecordGetPayload<{
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
    const enrich = (r: RecordWithOrgUser) => {
      const teamName = resolveTeamName(r.user as OrgUserLite | null, orgLookup);
      return {
        ...r,
        late_minutes: calcLateMinutes(r.check_in_at, lateAfterMinutes),
        status: displayStatus(r, shiftConfig),
        total_hours: displayTotalHours(r, shiftConfig),
        user: r.user
          ? {
              ...r.user,
              employee: r.user.employee
                ? { ...r.user.employee, team_name: teamName }
                : null,
            }
          : null,
      };
    };

    // lọc theo trạng thái — status TÍNH LẠI ở tầng app nên KHÔNG lọc/đếm bằng cột DB
    // (stale). sort "org" cũng cần app-layer (không có cột DB tương ứng). Nạp toàn bộ
    // trong phạm vi (cap an toàn), enrich, lọc/sắp xếp, rồi phân trang tại app.
    if (dto.status || isOrgSort) {
      // sort "org" dùng ORG_SORT_CAP (= EXPORT_LIMIT bên Excel) — KHÔNG dùng
      // STATUS_FILTER_CAP nhỏ hơn, tránh listRecords/exportToExcel fetch 2 tập khác nhau
      // trên khoảng ngày rất rộng (>5000 bản ghi) làm Excel lệch khỏi giao diện.
      const all = await this.prisma.attendanceRecord.findMany({
        where,
        include,
        orderBy,
        take: isOrgSort ? ORG_SORT_CAP : STATUS_FILTER_CAP,
      });
      let enriched = all.map(enrich);
      if (dto.status) {
        enriched = enriched.filter((r) => r.status === dto.status);
      }
      if (isOrgSort) {
        enriched = [...enriched].sort((a, b) => {
          const cmp = compareByOrgOrder(
            toOrgSortRow(a.user as OrgUserLite | null, a.user?.employee?.team_name ?? null),
            toOrgSortRow(b.user as OrgUserLite | null, b.user?.employee?.team_name ?? null),
          );
          if (cmp !== 0) return cmp;
          const dateCmp = a.work_date.getTime() - b.work_date.getTime();
          return dateCmp !== 0 ? dateCmp : a.id - b.id;
        });
      }
      return {
        data: enriched.slice(skip, skip + pageSize),
        pagination: {
          page,
          page_size: pageSize,
          total: enriched.length,
          total_pages: Math.ceil(enriched.length / pageSize),
        },
      };
    }

    const [records, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({ where, include, orderBy, skip, take: pageSize }),
      this.prisma.attendanceRecord.count({ where }),
    ]);
    const data = records.map(enrich);

    return {
      data,
      pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
    };
  }

  /** Chi tiết 1 bản ghi — scope THẬT theo `attendance.view` (ngoài phạm vi → 404). */
  async getRecordById(id: number, userId: number, ownerIds: number[] | 'all') {
    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            full_name: true,
            email: true,
            // office_id để fallback hiển thị "văn phòng được gán" cho bản ghi CŨ
            // (trước chưa lưu check_in_office_id / check_out_office_id).
            employee: { select: { position: true, office_id: true } },
          },
        },
      },
    });
    if (!record) throw new NotFoundException('Không tìm thấy bản ghi chấm công.');
    // Ngoài phạm vi attendance.view (Mẫu B) → 404,
    // KHÔNG 403 — tránh lộ "id này tồn tại".
    if (ownerIds !== 'all' && !ownerIds.includes(record.user_id)) {
      throw new NotFoundException('Không tìm thấy bản ghi chấm công.');
    }

    // Văn phòng nơi nhân viên chấm công (cơ chế IP không lưu lat/lng).
    // Ưu tiên office_id đã lưu lúc chấm; fallback văn phòng được gán cho bản ghi cũ.
    const assignedOfficeId = record.user?.employee?.office_id ?? null;
    const officeIds = [
      record.check_in_office_id,
      record.check_out_office_id,
      assignedOfficeId,
    ].filter((v): v is number => typeof v === 'number');
    const officeNameById = new Map<number, string>();
    if (officeIds.length > 0) {
      const offices = await this.prisma.attendanceOffice.findMany({
        where: { id: { in: [...new Set(officeIds)] } },
        select: { id: true, name: true },
      });
      for (const o of offices) officeNameById.set(o.id, o.name);
    }
    const officeNameOf = (oid: number | null): string | null =>
      oid != null ? (officeNameById.get(oid) ?? null) : null;
    const fallbackOfficeName = officeNameOf(assignedOfficeId);
    const checkInOfficeName =
      officeNameOf(record.check_in_office_id) ?? fallbackOfficeName;
    const checkOutOfficeName =
      officeNameOf(record.check_out_office_id) ?? fallbackOfficeName;

    // Đi muộn: tính LẠI tại chỗ từ check_in_at theo mốc cấu hình (late_after, mặc định 08:10) —
    // đúng cho cả bản ghi chỉ lưu late_minutes lúc check-out. Qua mốc cấu hình là đi muộn.
    const shiftConfig = await this.getShiftConfig();
    const lateAfterMinutes = hmToMinutes(shiftConfig.late_after);
    const lateActual = calcLateMinutes(record.check_in_at, lateAfterMinutes);
    // status + total_hours tính LẠI từ giờ + cấu hình (KHÔNG tin giá trị lưu DB — có thể stale:
    // total_hours bản ghi cũ chưa trừ nghỉ trưa).
    return {
      ...record,
      status: displayStatus(record, shiftConfig),
      late_minutes: lateActual,
      total_hours: displayTotalHours(record, shiftConfig),
      check_in_office_name: checkInOfficeName,
      check_out_office_name: checkOutOfficeName,
    };
  }

  /**
   * Stream ảnh selfie (proof) của 1 bản ghi qua BE proxy — scope THẬT theo
   * `attendance.view` (ngoài phạm vi → 404, KHÔNG 403).
   */
  async streamProof(
    id: number,
    slot: 'in' | 'out',
    userId: number,
    ownerIds: number[] | 'all',
  ): Promise<{ body: Readable; contentType: string; contentLength?: number }> {
    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id },
      select: { user_id: true, check_in_proof_key: true, check_out_proof_key: true },
    });
    if (!record) throw new NotFoundException('Không tìm thấy bản ghi chấm công.');
    // Ngoài phạm vi attendance.view → 404, KHÔNG 403.
    if (ownerIds !== 'all' && !ownerIds.includes(record.user_id)) {
      throw new NotFoundException('Không tìm thấy bản ghi chấm công.');
    }
    const key = slot === 'in' ? record.check_in_proof_key : record.check_out_proof_key;
    if (!key) {
      throw new NotFoundException('Không có ảnh selfie cho bản ghi này.');
    }
    const stream = await this.storageService.getObjectStream(key);
    return {
      body: stream.body,
      contentType: stream.contentType,
      contentLength: stream.contentLength,
    };
  }

  /**
   * Xóa bản ghi chấm công (super_admin + hr) để nhân viên CHẤM LẠI từ đầu.
   * Nhờ UNIQUE(user_id, work_date), sau khi xóa thì lần chấm công kế tiếp của nhân
   * viên sẽ tạo bản ghi mới. KHÔNG reset thiết bị (registered_device_id nằm ở bảng
   * employee) → nhân viên chấm lại bằng thiết bị cũ; muốn đổi thiết bị thì dùng
   * resetDevice riêng.
   */
  async deleteRecord(id: number, actorUserId: number, ownerIds: number[] | 'all') {
    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id },
      select: { id: true, user_id: true, work_date: true },
    });
    if (!record || (ownerIds !== 'all' && !ownerIds.includes(record.user_id))) {
      throw new NotFoundException('Không tìm thấy bản ghi chấm công.');
    }

    await this.prisma.attendanceRecord.delete({ where: { id } });

    this.logger.log(
      `Attendance record ${id} (user ${record.user_id}, date ${record.work_date
        .toISOString()
        .slice(0, 10)}) deleted by user ${actorUserId}`,
    );
    return { ok: true, id, user_id: record.user_id };
  }

  /** super_admin sửa bản ghi (manual correction) */
  async patchRecord(id: number, dto: PatchAttendanceDto, ownerIds: number[] | 'all') {
    const record = await this.prisma.attendanceRecord.findUnique({ where: { id } });
    if (!record || (ownerIds !== 'all' && !ownerIds.includes(record.user_id))) {
      throw new NotFoundException('Không tìm thấy bản ghi chấm công.');
    }

    const shiftConfig = await this.getShiftConfig();
    const lateAfterMinutes = hmToMinutes(shiftConfig.late_after);
    const lunchWindow = { start: shiftConfig.lunch_start, end: shiftConfig.lunch_end };
    const updateData: Record<string, unknown> = {};
    if (dto.check_in_at !== undefined) updateData['check_in_at'] = new Date(dto.check_in_at);
    if (dto.check_out_at !== undefined) updateData['check_out_at'] = new Date(dto.check_out_at);
    if (dto.check_in_note !== undefined) updateData['check_in_note'] = dto.check_in_note;
    if (dto.check_out_note !== undefined) updateData['check_out_note'] = dto.check_out_note;
    if (dto.total_hours !== undefined) updateData['total_hours'] = dto.total_hours;
    if (dto.late_minutes !== undefined) updateData['late_minutes'] = dto.late_minutes;
    if (dto.status !== undefined) updateData['status'] = dto.status;

    const newCheckIn = (updateData['check_in_at'] as Date | undefined) ?? record.check_in_at;
    const newCheckOut = (updateData['check_out_at'] as Date | undefined) ?? record.check_out_at;
    if (dto.total_hours === undefined) {
      const computed = calcTotalHours(newCheckIn, newCheckOut, lunchWindow);
      if (computed !== null) updateData['total_hours'] = computed;
    }
    if (dto.late_minutes === undefined) {
      updateData['late_minutes'] = calcLateMinutes(newCheckIn, lateAfterMinutes);
    }
    if (dto.status === undefined) {
      updateData['status'] = calcStatus(newCheckIn, newCheckOut, lunchWindow);
    }

    return this.prisma.attendanceRecord.update({ where: { id }, data: updateData });
  }

  // ============================================================
  // CẤU HÌNH CA LÀM VIỆC (Setting KV)
  // ============================================================

  async getShiftConfig(): Promise<ShiftConfig> {
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: ATTENDANCE_SHIFT_KEY },
        select: { value: true },
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value) as Partial<
          Record<
            'work_start' | 'work_end' | 'late_after' | 'lunch_start' | 'lunch_end',
            string
          >
        > & {
          review_max_hours?: unknown;
          half_day_min_hours?: unknown;
          full_day_min_hours?: unknown;
        };
        const pick = (v: string | undefined, fallback: string) =>
          v && HM_RE.test(v) ? v : fallback;
        // Ngưỡng giờ: số hợp lệ trong [0, 24]; ngoài khoảng/không phải số → fallback.
        const pickNum = (v: unknown, fallback: number) =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 24 ? v : fallback;
        return {
          work_start: pick(parsed.work_start, DEFAULT_SHIFT_CONFIG.work_start),
          work_end: pick(parsed.work_end, DEFAULT_SHIFT_CONFIG.work_end),
          late_after: pick(parsed.late_after, DEFAULT_SHIFT_CONFIG.late_after),
          lunch_start: pick(parsed.lunch_start, DEFAULT_SHIFT_CONFIG.lunch_start),
          lunch_end: pick(parsed.lunch_end, DEFAULT_SHIFT_CONFIG.lunch_end),
          review_max_hours: pickNum(parsed.review_max_hours, DEFAULT_SHIFT_CONFIG.review_max_hours),
          half_day_min_hours: pickNum(parsed.half_day_min_hours, DEFAULT_SHIFT_CONFIG.half_day_min_hours),
          full_day_min_hours: pickNum(parsed.full_day_min_hours, DEFAULT_SHIFT_CONFIG.full_day_min_hours),
        };
      }
    } catch (err) {
      this.logger.error(`getShiftConfig failed: ${(err as Error)?.message}`);
    }
    return { ...DEFAULT_SHIFT_CONFIG };
  }

  async updateShiftConfig(dto: UpdateAttendanceSettingsDto, userId: number) {
    // Merge với config hiện tại — lunch_start/lunch_end optional (giữ giá trị cũ nếu không gửi).
    const current = await this.getShiftConfig();
    const next: ShiftConfig = {
      work_start: dto.work_start,
      work_end: dto.work_end,
      late_after: dto.late_after,
      lunch_start: dto.lunch_start ?? current.lunch_start,
      lunch_end: dto.lunch_end ?? current.lunch_end,
      review_max_hours: dto.review_max_hours ?? current.review_max_hours,
      half_day_min_hours: dto.half_day_min_hours ?? current.half_day_min_hours,
      full_day_min_hours: dto.full_day_min_hours ?? current.full_day_min_hours,
    };
    // Chặn cửa sổ nghỉ trưa đảo ngược ở tầng API (FE đã guard, nhưng client khác có thể bỏ qua).
    // So sánh chuỗi HH:MM hợp lệ vì định dạng zero-pad cố định.
    if (next.lunch_end <= next.lunch_start) {
      throw new BadRequestException('Giờ kết thúc nghỉ trưa phải sau giờ bắt đầu.');
    }
    // 3 ngưỡng phải tăng dần: Xem xét < Chưa đủ nửa ngày < Đủ công (nếu không các dải biến mất/đảo ngược).
    if (
      !(next.review_max_hours < next.half_day_min_hours) ||
      !(next.half_day_min_hours < next.full_day_min_hours)
    ) {
      throw new BadRequestException(
        'Ngưỡng giờ phải tăng dần: "Xem xét" < "Chưa đủ nửa ngày" < "Đủ công".',
      );
    }
    const value = JSON.stringify(next);
    await this.prisma.setting.upsert({
      where: { key: ATTENDANCE_SHIFT_KEY },
      update: { value, updated_by: userId },
      create: { key: ATTENDANCE_SHIFT_KEY, value, updated_by: userId },
    });
    this.logger.log(`Attendance shift config updated by user ${userId}: ${value}`);
    return next;
  }

  /** Danh sách thứ 7 được tính đi làm (YYYY-MM-DD). Mặc định [] (mọi thứ 7 nghỉ). */
  async getWorkingSaturdays(): Promise<string[]> {
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: ATTENDANCE_WORKING_SAT_KEY },
        select: { value: true },
      });
      if (row?.value) {
        const parsed: unknown = JSON.parse(row.value);
        if (Array.isArray(parsed)) {
          return parsed.filter(
            (d): d is string => typeof d === 'string' && SAT_DATE_RE.test(d),
          );
        }
      }
    } catch (err) {
      this.logger.error(`getWorkingSaturdays failed: ${(err as Error)?.message}`);
    }
    return [];
  }

  /** Lưu danh sách thứ 7 đi làm — chỉ nhận ngày YYYY-MM-DD hợp lệ + ĐÚNG là thứ 7. Dedupe + sort. */
  async setWorkingSaturdays(
    dates: string[],
    userId: number,
  ): Promise<{ dates: string[] }> {
    const valid = Array.from(
      new Set(
        (dates ?? []).filter((d) => {
          if (typeof d !== 'string' || !SAT_DATE_RE.test(d)) return false;
          const dt = new Date(`${d}T00:00:00Z`);
          return !Number.isNaN(dt.getTime()) && dt.getUTCDay() === 6; // 6 = thứ 7
        }),
      ),
    ).sort();
    const value = JSON.stringify(valid);
    await this.prisma.setting.upsert({
      where: { key: ATTENDANCE_WORKING_SAT_KEY },
      update: { value, updated_by: userId },
      create: { key: ATTENDANCE_WORKING_SAT_KEY, value, updated_by: userId },
    });
    this.logger.log(`Working saturdays updated by user ${userId}: ${value}`);
    return { dates: valid };
  }

  private async resolveLateAfterMinutes(): Promise<number> {
    const cfg = await this.getShiftConfig();
    return hmToMinutes(cfg.late_after);
  }

  // ============================================================
  // THỐNG KÊ TỔNG HỢP (popup biểu đồ)
  // ============================================================

  /**
   * Thống kê chấm công tổng hợp phục vụ popup biểu đồ.
   * Mặc định khoảng = tháng hiện tại (giờ VN). Chỉ admin (super_admin/hr) gọi (gate ở controller).
   * - `summary`: tổng lượt chấm trong kỳ (đúng giờ / đi muộn / tổng phút muộn).
   * - `distinct_checked_in` vs `not_checked_in`: số NV ĐÃ chấm ít nhất 1 lần / chưa chấm lần nào.
   * - `daily`: chuỗi theo ngày cho biểu đồ đường.
   */
  async getAttendanceStats(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ) {
    const { fromStr, toStr } = resolveStatsRange(dto);
    const empFilter = buildStatsEmpFilter(dto, scopeUserIds);
    const hasFilter = !!(
      dto.department?.length ||
      dto.team_id?.length ||
      dto.office_id?.length
    );
    // CÓ scope (team_lead → subtree) HOẶC có bộ lọc → đi đường roster (đã scope). KHÔNG scope +
    // KHÔNG lọc (super_admin/hr/kế toán xem tất cả) → GIỮ NGUYÊN query cũ (total = user.count;
    // daily/distinct chỉ trên attendance_records) để con số thẻ + biểu đồ KHÔNG đổi.
    const useRoster = scopeUserIds != null || hasFilter;

    const totalPromise: Promise<number> = useRoster
      ? this.prisma
          .$queryRaw<Array<{ count: number }>>`
            SELECT COUNT(*)::int AS count
            FROM employees e
            JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
            WHERE e.deleted_at IS NULL AND ${employedRosterCond(Prisma.sql`${fromStr}::date`)} ${empFilter}
          `
          .then((r) => r[0]?.count ?? 0)
      : this.prisma.user.count({ where: { deleted_at: null, status: 'active' } });

    const dailyPromise: Promise<DailyStatRow[]> = useRoster
      ? this.prisma.$queryRaw<DailyStatRow[]>`
          SELECT to_char(ar.work_date, 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE ar.check_in_at IS NOT NULL)::int AS checked_in,
            COUNT(*) FILTER (WHERE ar.check_out_at IS NOT NULL)::int AS checked_out,
            COUNT(*) FILTER (WHERE ar.check_in_at IS NOT NULL AND ar.check_out_at IS NOT NULL)::int AS complete,
            COUNT(*) FILTER (WHERE ar.check_in_at IS NOT NULL AND COALESCE(ar.late_minutes, 0) > 0)::int AS late,
            COUNT(*) FILTER (WHERE ar.check_in_at IS NOT NULL AND COALESCE(ar.late_minutes, 0) = 0)::int AS on_time,
            COALESCE(SUM(ar.late_minutes) FILTER (WHERE ar.check_in_at IS NOT NULL), 0)::int AS late_minutes
          FROM attendance_records ar
          JOIN employees e ON e.user_id = ar.user_id AND e.deleted_at IS NULL AND ${employedRosterCond(Prisma.raw('ar.work_date'))}
          JOIN users u ON u.id = ar.user_id AND u.deleted_at IS NULL
          WHERE ar.work_date >= ${fromStr}::date AND ar.work_date <= ${toStr}::date ${empFilter}
          GROUP BY ar.work_date
          ORDER BY ar.work_date ASC
        `
      : this.prisma.$queryRaw<DailyStatRow[]>`
          SELECT to_char(work_date, 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE check_in_at IS NOT NULL)::int AS checked_in,
            COUNT(*) FILTER (WHERE check_out_at IS NOT NULL)::int AS checked_out,
            COUNT(*) FILTER (WHERE check_in_at IS NOT NULL AND check_out_at IS NOT NULL)::int AS complete,
            COUNT(*) FILTER (WHERE check_in_at IS NOT NULL AND COALESCE(late_minutes, 0) > 0)::int AS late,
            COUNT(*) FILTER (WHERE check_in_at IS NOT NULL AND COALESCE(late_minutes, 0) = 0)::int AS on_time,
            COALESCE(SUM(late_minutes) FILTER (WHERE check_in_at IS NOT NULL), 0)::int AS late_minutes
          FROM attendance_records
          WHERE work_date >= ${fromStr}::date AND work_date <= ${toStr}::date
          GROUP BY work_date
          ORDER BY work_date ASC
        `;

    const distinctPromise: Promise<Array<{ count: number }>> = useRoster
      ? this.prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(DISTINCT ar.user_id)::int AS count
          FROM attendance_records ar
          JOIN employees e ON e.user_id = ar.user_id AND e.deleted_at IS NULL AND ${employedRosterCond(Prisma.raw('ar.work_date'))}
          JOIN users u ON u.id = ar.user_id AND u.deleted_at IS NULL
          WHERE ar.work_date >= ${fromStr}::date AND ar.work_date <= ${toStr}::date
            AND ar.check_in_at IS NOT NULL ${empFilter}
        `
      : this.prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(DISTINCT user_id)::int AS count
          FROM attendance_records
          WHERE work_date >= ${fromStr}::date AND work_date <= ${toStr}::date
            AND check_in_at IS NOT NULL
        `;

    const [totalEmployees, dailyRows, distinctRows, byTeam, byDepartment, earlyLeave] =
      await Promise.all([
        totalPromise,
        dailyPromise,
        distinctPromise,
        this.getStatsByTeam(dto, scopeUserIds),
        this.getStatsByDepartment(dto, scopeUserIds),
        this.getEarlyLeaveStats(dto, scopeUserIds),
      ]);

    const distinctCheckedIn = distinctRows[0]?.count ?? 0;
    const summary = dailyRows.reduce(
      (acc, d) => {
        acc.checked_in += d.checked_in;
        acc.checked_out += d.checked_out;
        acc.complete += d.complete;
        acc.on_time += d.on_time;
        acc.late += d.late;
        acc.total_late_minutes += d.late_minutes;
        return acc;
      },
      { checked_in: 0, checked_out: 0, complete: 0, on_time: 0, late: 0, total_late_minutes: 0 },
    );

    return {
      date_from: fromStr,
      date_to: toStr,
      total_employees: totalEmployees,
      distinct_checked_in: distinctCheckedIn,
      not_checked_in: Math.max(0, totalEmployees - distinctCheckedIn),
      summary,
      daily: dailyRows.map((d) => ({
        date: d.day,
        checked_in: d.checked_in,
        on_time: d.on_time,
        late: d.late,
      })),
      by_team: byTeam,
      by_department: byDepartment,
      early_leave: earlyLeave,
    };
  }

  /**
   * Thống kê chấm công theo Team (= quản lý trực tiếp `users.manager_id`) trong khoảng + bộ lọc.
   * Roster-based (`FROM employees LEFT JOIN attendance_records`) để tính đúng Vắng + Tỷ lệ kể cả
   * NV 0 lần chấm. Đếm theo NGƯỜI distinct. Dùng chung cho popup lẫn Excel.
   */
  async getStatsByTeam(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<TeamStatRow[]> {
    const { fromStr, toStr } = resolveStatsRange(dto);
    const empFilter = buildStatsEmpFilter(dto, scopeUserIds);
    const rows = await this.prisma.$queryRaw<
      Array<RawGroupStat & { team_id: number | null; team_name: string }>
    >`
      SELECT
        resolved.team_id::int AS team_id,
        COALESCE(t.name, 'Chưa có team') AS team_name,
        COUNT(DISTINCT e.user_id)::int AS headcount,
        COUNT(DISTINCT e.user_id) FILTER (WHERE ar.check_in_at IS NOT NULL)::int AS checked_in_people,
        COUNT(DISTINCT e.user_id) FILTER (WHERE ar.check_in_at IS NOT NULL AND ar.check_out_at IS NOT NULL)::int AS present_people,
        COUNT(DISTINCT e.user_id) FILTER (WHERE ar.check_in_at IS NOT NULL AND COALESCE(ar.late_minutes, 0) > 0)::int AS late_people,
        COALESCE(SUM(ar.late_minutes) FILTER (WHERE ar.check_in_at IS NOT NULL), 0)::int AS total_late_minutes
      FROM employees e
      JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
      CROSS JOIN LATERAL (SELECT ${RESOLVED_TEAM_ID_SQL} AS team_id) resolved
      LEFT JOIN teams t ON t.id = resolved.team_id
      LEFT JOIN attendance_records ar ON ar.user_id = e.user_id
        AND ar.work_date >= ${fromStr}::date AND ar.work_date <= ${toStr}::date
      WHERE e.deleted_at IS NULL AND ${employedRosterCond(Prisma.sql`${fromStr}::date`)} ${empFilter}
      GROUP BY resolved.team_id, COALESCE(t.name, 'Chưa có team')
      ORDER BY headcount DESC, team_name ASC
    `;
    return rows.map((r) => deriveGroupStat(r));
  }

  /**
   * Thống kê chấm công theo Phòng ban (`employees.department`) + Trưởng phòng (suy từ NV có chức
   * danh chứa "trưởng", ưu tiên "trưởng phòng"). Cùng cách đếm như `getStatsByTeam`.
   */
  async getStatsByDepartment(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<DepartmentStatRow[]> {
    const { fromStr, toStr } = resolveStatsRange(dto);
    const empFilter = buildStatsEmpFilter(dto, scopeUserIds);
    const [rows, heads] = await Promise.all([
      this.prisma.$queryRaw<Array<RawGroupStat & { department: string }>>`
        SELECT
          COALESCE(NULLIF(TRIM(e.department), ''), 'Chưa phân phòng') AS department,
          COUNT(DISTINCT e.user_id)::int AS headcount,
          COUNT(DISTINCT e.user_id) FILTER (WHERE ar.check_in_at IS NOT NULL)::int AS checked_in_people,
          COUNT(DISTINCT e.user_id) FILTER (WHERE ar.check_in_at IS NOT NULL AND ar.check_out_at IS NOT NULL)::int AS present_people,
          COUNT(DISTINCT e.user_id) FILTER (WHERE ar.check_in_at IS NOT NULL AND COALESCE(ar.late_minutes, 0) > 0)::int AS late_people,
          COALESCE(SUM(ar.late_minutes) FILTER (WHERE ar.check_in_at IS NOT NULL), 0)::int AS total_late_minutes
        FROM employees e
        JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
        LEFT JOIN attendance_records ar ON ar.user_id = e.user_id
          AND ar.work_date >= ${fromStr}::date AND ar.work_date <= ${toStr}::date
        WHERE e.deleted_at IS NULL AND ${employedRosterCond(Prisma.sql`${fromStr}::date`)} ${empFilter}
        GROUP BY COALESCE(NULLIF(TRIM(e.department), ''), 'Chưa phân phòng')
        ORDER BY headcount DESC, department ASC
      `,
      // Trưởng phòng: NV trong phòng có chức danh chứa "trưởng" (ưu tiên "trưởng phòng" → rank 1).
      this.prisma.$queryRaw<
        Array<{ department: string; head_name: string | null; head_rank: number }>
      >`
        SELECT
          COALESCE(NULLIF(TRIM(e.department), ''), 'Chưa phân phòng') AS department,
          u.full_name AS head_name,
          CASE WHEN e.position ILIKE '%trưởng phòng%' THEN 1 ELSE 2 END AS head_rank
        FROM employees e
        JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
        WHERE e.deleted_at IS NULL AND ${employedRosterCond(Prisma.sql`${fromStr}::date`)}
          AND e.position ILIKE '%trưởng%' ${empFilter}
        ORDER BY head_rank ASC, u.full_name ASC
      `,
    ]);

    const headMap = new Map<string, string>();
    for (const h of heads) {
      if (h.head_name && !headMap.has(h.department)) {
        headMap.set(h.department, h.head_name);
      }
    }
    return rows.map((r) => ({
      ...deriveGroupStat(r),
      head_name: headMap.get(r.department) ?? null,
    }));
  }

  /**
   * CHI TIẾT NHÂN VIÊN trong kỳ + bộ lọc (Sheet 2 của export theo Team/Phòng ban). Roster-based
   * (`FROM employees LEFT JOIN attendance_records`) → mỗi NV thuộc bộ lọc 1 dòng (kể cả 0 lần
   * chấm). Đếm theo NGÀY, presence-based để đối soát với Sheet 1: đủ công = có cả vào+ra; thiếu
   * công = có vào nhưng thiếu ra. Team resolve 3 tầng (đồng bộ Cài đặt → Team). Scope theo role.
   * Tránh cột `total_hours`/`status` stale — chỉ dùng presence + `late_minutes` + status nghỉ phép.
   */
  async getEmployeeAttendanceSummary(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<EmployeeAttendanceSummaryRow[]> {
    const { fromStr, toStr } = resolveStatsRange(dto);
    const empFilter = buildStatsEmpFilter(dto, scopeUserIds);
    return this.prisma.$queryRaw<EmployeeAttendanceSummaryRow[]>`
      SELECT
        COALESCE(NULLIF(TRIM(e.employee_code), ''), 'NV' || LPAD(e.id::text, 4, '0')) AS employee_code,
        u.full_name AS full_name,
        COALESCE(NULLIF(TRIM(e.department), ''), 'Chưa phân phòng') AS department,
        COALESCE(t.name, 'Chưa có team') AS team_name,
        COALESCE(off.name, '') AS office_name,
        COUNT(ar.id) FILTER (WHERE ar.check_in_at IS NOT NULL AND ar.check_out_at IS NOT NULL)::int AS full_days,
        COUNT(ar.id) FILTER (WHERE ar.check_in_at IS NOT NULL AND ar.check_out_at IS NULL)::int AS insufficient_days,
        COUNT(ar.id) FILTER (WHERE ar.check_in_at IS NOT NULL AND COALESCE(ar.late_minutes, 0) > 0)::int AS late_days,
        COALESCE(SUM(ar.late_minutes) FILTER (WHERE ar.check_in_at IS NOT NULL), 0)::int AS total_late_minutes,
        COUNT(ar.id) FILTER (WHERE ar.status IN ('leave', 'maternity'))::int AS leave_days,
        COUNT(ar.id) FILTER (WHERE ar.check_in_at IS NOT NULL)::int AS checked_in_days
      FROM employees e
      JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
      CROSS JOIN LATERAL (SELECT ${RESOLVED_TEAM_ID_SQL} AS team_id) resolved
      LEFT JOIN teams t ON t.id = resolved.team_id
      LEFT JOIN attendance_offices off ON off.id = e.office_id
      LEFT JOIN attendance_records ar ON ar.user_id = e.user_id
        AND ar.work_date >= ${fromStr}::date AND ar.work_date <= ${toStr}::date
      WHERE e.deleted_at IS NULL AND ${employedRosterCond(Prisma.sql`${fromStr}::date`)} ${empFilter}
      GROUP BY e.id, u.full_name, COALESCE(t.name, 'Chưa có team'), COALESCE(off.name, '')
      ORDER BY team_name ASC, u.full_name ASC
    `;
  }

  /**
   * Số liệu "Về sớm" cho popup Thống kê: đếm đơn early_leave (total/approved/rejected/pending),
   * tổng phút thiếu so với đủ công (8h) trên các ngày về sớm, và top NV về sớm nhiều nhất.
   * Scope theo `scopeUserIds` (role) + bộ lọc Phòng ban/Team/Văn phòng (đồng nhất roster của
   * `getAttendanceStats`). Phút thiếu lấy từ bản ghi chấm công khớp (user, ngày) — KHÔNG ghi đè.
   */
  async getEarlyLeaveStats(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<EarlyLeaveStats> {
    const empty: EarlyLeaveStats = {
      total: 0,
      approved: 0,
      rejected: 0,
      pending: 0,
      total_minutes: 0,
      approval_rate: 0,
      top_leavers: [],
    };
    const { fromStr, toStr } = resolveStatsRange(dto);
    const fromDate = parseDateToUtcMidnight(fromStr);
    const toDate = parseDateToUtcMidnight(toStr);
    const empFilter = buildStatsEmpFilter(dto, scopeUserIds);
    const hasFilter = !!(
      dto.department?.length ||
      dto.team_id?.length ||
      dto.office_id?.length
    );
    const scoped = scopeUserIds != null || hasFilter;

    // Có scope (team_lead) / có lọc → giới hạn user_ids theo roster active đã scope.
    let allowedUserIds: number[] | null = null;
    if (scoped) {
      const rows = await this.prisma.$queryRaw<Array<{ user_id: number }>>`
        SELECT e.user_id::int AS user_id
        FROM employees e
        JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
        WHERE e.deleted_at IS NULL AND ${employedRosterCond(Prisma.sql`${fromStr}::date`)} ${empFilter}
      `;
      allowedUserIds = rows.map((r) => r.user_id);
      if (allowedUserIds.length === 0) return empty;
    }

    const reqWhere: Prisma.AttendanceRequestWhereInput = {
      type: 'early_leave',
      work_date: { gte: fromDate, lte: toDate },
    };
    if (allowedUserIds) reqWhere.user_id = { in: allowedUserIds };
    const reqs = await this.prisma.attendanceRequest.findMany({
      where: reqWhere,
      select: { user_id: true, work_date: true, status: true },
    });
    if (reqs.length === 0) return empty;

    let approved = 0;
    let rejected = 0;
    let pending = 0;
    const byUser = new Map<number, { count: number; minutes: number }>();
    for (const r of reqs) {
      if (r.status === 'approved') approved += 1;
      else if (r.status === 'rejected') rejected += 1;
      else pending += 1;
      const u = byUser.get(r.user_id) ?? { count: 0, minutes: 0 };
      u.count += 1;
      byUser.set(r.user_id, u);
    }

    // Phút thiếu: nạp bản ghi khớp (user, ngày) của đơn → tính deficit so với đủ công.
    const shiftConfig = await this.getShiftConfig();
    const fullDayMinutes = shiftConfig.full_day_min_hours * 60;
    const reqUserIds = [...new Set(reqs.map((r) => r.user_id))];
    const reqDateSet = new Set(
      reqs.map((r) => `${r.user_id}:${r.work_date.toISOString().slice(0, 10)}`),
    );
    const records = await this.prisma.attendanceRecord.findMany({
      where: { user_id: { in: reqUserIds }, work_date: { gte: fromDate, lte: toDate } },
      select: {
        user_id: true,
        work_date: true,
        check_in_at: true,
        check_out_at: true,
        total_hours: true,
        status: true,
      },
    });
    let totalMinutes = 0;
    for (const rec of records) {
      const k = `${rec.user_id}:${rec.work_date.toISOString().slice(0, 10)}`;
      if (!reqDateSet.has(k)) continue;
      const hours = displayTotalHours(rec, shiftConfig);
      if (hours == null) continue;
      const deficit = Math.round(fullDayMinutes - hours * 60);
      if (deficit > 0) {
        totalMinutes += deficit;
        const u = byUser.get(rec.user_id);
        if (u) u.minutes += deficit;
      }
    }

    const names = await this.prisma.user.findMany({
      where: { id: { in: reqUserIds } },
      select: { id: true, full_name: true, email: true },
    });
    const nameMap = new Map(
      names.map((u) => [u.id, u.full_name ?? u.email ?? String(u.id)]),
    );
    const top_leavers = [...byUser.entries()]
      .map(([user_id, v]) => ({
        user_id,
        full_name: nameMap.get(user_id) ?? null,
        count: v.count,
        minutes: v.minutes,
      }))
      .sort((a, b) => b.count - a.count || b.minutes - a.minutes)
      .slice(0, 10);

    const approval_rate =
      approved + rejected > 0
        ? Math.round((approved / (approved + rejected)) * 1000) / 10
        : 0;

    return {
      total: reqs.length,
      approved,
      rejected,
      pending,
      total_minutes: totalMinutes,
      approval_rate,
      top_leavers,
    };
  }

  /**
   * "Phân tích nghỉ phép" (4 biểu đồ): donut ngày nghỉ-đã-duyệt theo loại + donut tất-cả-đơn
   * theo loại + cột xếp chồng theo tuần × phòng ban + donut ngày nghỉ theo giới tính.
   * Roster-based (scope `scopeUserIds` + bộ lọc Phòng ban/Team/Văn phòng) → đếm đơn trong JS.
   * Mỗi đơn = 1 `work_date` = 1 "ngày"; tuần/giới tính/ngày-theo-loại đều dùng đơn ĐÃ DUYỆT (cả
   * 6 loại) nên Σ by_type_days = Σ by_gender = Σ by_week (đối soát được). by_type_requests đếm
   * MỌI đơn (pending+approved+rejected). KHÔNG gộp vào getAttendanceStats (giữ mock $queryRaw cũ).
   */
  async getLeaveAnalytics(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<LeaveAnalytics> {
    const { fromStr, toStr } = resolveStatsRange(dto);
    const fromDate = parseDateToUtcMidnight(fromStr);
    const toDate = parseDateToUtcMidnight(toStr);
    const empFilter = buildStatsEmpFilter(dto, scopeUserIds);
    const weeks = buildLeaveWeekBuckets(fromStr, toStr);

    const buildTypeSlices = (counts: Map<string, number>): LeaveTypeSlice[] =>
      LEAVE_ANALYTICS_TYPES.map((t) => ({
        type: t.type,
        label: t.label,
        value: counts.get(t.type) ?? 0,
      }));
    const buildGenderSlices = (
      counts: Map<'M' | 'F' | 'unknown', number>,
    ): LeaveGenderSlice[] =>
      (['M', 'F', 'unknown'] as const).map((g) => ({
        gender: g,
        label: LEAVE_GENDER_LABELS[g],
        value: counts.get(g) ?? 0,
      }));
    const empty: LeaveAnalytics = {
      date_from: fromStr,
      date_to: toStr,
      by_type_days: buildTypeSlices(new Map()),
      by_type_requests: buildTypeSlices(new Map()),
      by_week: { weeks, departments: [] },
      by_gender: buildGenderSlices(new Map()),
    };

    // Roster đã scope: user_id → { gender, department } (để nhóm theo giới tính + phòng ban).
    const roster = await this.prisma.$queryRaw<
      Array<{ user_id: number; gender: string | null; department: string }>
    >`
      SELECT
        e.user_id::int AS user_id,
        e.gender AS gender,
        COALESCE(NULLIF(TRIM(e.department), ''), 'Chưa phân phòng') AS department
      FROM employees e
      JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
      WHERE e.deleted_at IS NULL AND ${employedRosterCond(Prisma.sql`${fromStr}::date`)} ${empFilter}
    `;
    if (roster.length === 0) return empty;

    const userInfo = new Map<
      number,
      { gender: 'M' | 'F' | 'unknown'; department: string }
    >();
    for (const r of roster) {
      const gender = r.gender === 'M' ? 'M' : r.gender === 'F' ? 'F' : 'unknown';
      userInfo.set(r.user_id, { gender, department: r.department });
    }
    const userIds = [...userInfo.keys()];

    const reqs = await this.prisma.attendanceRequest.findMany({
      where: {
        user_id: { in: userIds },
        work_date: { gte: fromDate, lte: toDate },
      },
      select: { user_id: true, work_date: true, type: true, status: true },
    });

    const requestsByType = new Map<string, number>(); // mọi đơn theo loại
    const daysByType = new Map<string, number>(); // approved theo loại
    const daysByGender = new Map<'M' | 'F' | 'unknown', number>();
    const weekByDept = new Map<string, number[]>(); // phòng ban → count theo tuần (approved)
    const fromUtc = fromDate.getTime();

    for (const r of reqs) {
      requestsByType.set(r.type, (requestsByType.get(r.type) ?? 0) + 1);
      if (r.status !== 'approved') continue;
      daysByType.set(r.type, (daysByType.get(r.type) ?? 0) + 1);
      const info = userInfo.get(r.user_id);
      if (!info) continue; // an toàn — đơn ngoài roster đã bị WHERE loại
      daysByGender.set(info.gender, (daysByGender.get(info.gender) ?? 0) + 1);
      const weekIndex = Math.floor(
        (r.work_date.getTime() - fromUtc) / 86_400_000 / 7,
      );
      if (weekIndex < 0 || weekIndex >= weeks.length) continue;
      let series = weekByDept.get(info.department);
      if (!series) {
        series = new Array<number>(weeks.length).fill(0);
        weekByDept.set(info.department, series);
      }
      series[weekIndex] += 1;
    }

    const departments: LeaveDeptSeries[] = [...weekByDept.entries()]
      .map(([department, values]) => ({ department, values }))
      .sort((a, b) => {
        const sa = a.values.reduce((s, v) => s + v, 0);
        const sb = b.values.reduce((s, v) => s + v, 0);
        return sb - sa || a.department.localeCompare(b.department, 'vi');
      });

    return {
      date_from: fromStr,
      date_to: toStr,
      by_type_days: buildTypeSlices(daysByType),
      by_type_requests: buildTypeSlices(requestsByType),
      by_week: { weeks, departments },
      by_gender: buildGenderSlices(daysByGender),
    };
  }

  /**
   * Thống kê kỷ luật chấm công (3 khối): Top 10 nghỉ nhiều / Top 10 đi muộn-về sớm /
   * So sánh giới tính. Roster-based + tính trong JS từ records + đơn early_leave đã duyệt.
   * Scope theo `scopeUserIds` (quản lý) + bộ lọc Phòng ban/Team/Văn phòng.
   * - Vắng = ngày làm việc không có bản ghi (đơn phép tạo bản ghi → không tính vắng).
   * - Về sớm = max(0, work_end − giờ ra), loại ngày có đơn early_leave đã duyệt.
   */
  async getDisciplineStats(
    dto: QueryAttendanceStatsDto,
    scopeUserIds?: number[] | null,
  ): Promise<DisciplineStats> {
    const { fromStr, toStr } = resolveStatsRange(dto);
    const fromDate = parseDateToUtcMidnight(fromStr);
    const toDate = parseDateToUtcMidnight(toStr);
    const empFilter = buildStatsEmpFilter(dto, scopeUserIds);
    const shiftConfig = await this.getShiftConfig();
    const workingSat = new Set(await this.getWorkingSaturdays());
    const workdays = buildWorkdayList(fromStr, toStr, workingSat);
    const totalWorkdays = workdays.length;

    const empty: DisciplineStats = {
      date_from: fromStr,
      date_to: toStr,
      work_end: shiftConfig.work_end,
      total_workdays: totalWorkdays,
      top_absent: [],
      top_violation: [],
      by_gender: [],
    };

    const roster = await this.prisma.$queryRaw<
      Array<{
        user_id: number;
        full_name: string | null;
        employee_code: string | null;
        position: string | null;
        gender: string | null;
        team_name: string | null;
      }>
    >`
      SELECT
        e.user_id::int AS user_id,
        u.full_name AS full_name,
        e.employee_code AS employee_code,
        e.position AS position,
        e.gender AS gender,
        COALESCE(mgr.full_name, 'Chưa có quản lý') AS team_name
      FROM employees e
      JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
      LEFT JOIN users mgr ON mgr.id = u.manager_id
      WHERE e.deleted_at IS NULL AND ${employedRosterCond(Prisma.sql`${fromStr}::date`)} ${empFilter}
    `;
    if (roster.length === 0) return empty;

    const userIds = roster.map((r) => r.user_id);
    const records = await this.prisma.attendanceRecord.findMany({
      where: { user_id: { in: userIds }, work_date: { gte: fromDate, lte: toDate } },
      select: {
        user_id: true,
        work_date: true,
        check_in_at: true,
        check_out_at: true,
        total_hours: true,
        status: true,
      },
    });
    const approvedEarly = await this.prisma.attendanceRequest.findMany({
      where: {
        type: 'early_leave',
        status: 'approved',
        user_id: { in: userIds },
        work_date: { gte: fromDate, lte: toDate },
      },
      select: { user_id: true, work_date: true },
    });

    const recByUser = new Map<number, Map<string, DisciplineRec>>();
    for (const r of records) {
      const ds = r.work_date.toISOString().slice(0, 10);
      let m = recByUser.get(r.user_id);
      if (!m) {
        m = new Map<string, DisciplineRec>();
        recByUser.set(r.user_id, m);
      }
      m.set(ds, {
        check_in_at: r.check_in_at,
        check_out_at: r.check_out_at,
        total_hours: r.total_hours,
        status: r.status,
      });
    }
    const approvedEarlySet = new Set(
      approvedEarly.map((a) => `${a.user_id}:${a.work_date.toISOString().slice(0, 10)}`),
    );

    const lateAfter = hmToMinutes(shiftConfig.late_after);
    const workEndMin = hmToMinutes(shiftConfig.work_end);
    const fullDayMin = shiftConfig.full_day_min_hours;

    const absentRows: DisciplineAbsentRow[] = [];
    const violationRows: DisciplineViolationRow[] = [];
    type GAcc = { headcount: number; absent: number; late: number; early: number; full: number };
    const genderAcc = new Map<'M' | 'F' | 'unknown', GAcc>([
      ['M', { headcount: 0, absent: 0, late: 0, early: 0, full: 0 }],
      ['F', { headcount: 0, absent: 0, late: 0, early: 0, full: 0 }],
      ['unknown', { headcount: 0, absent: 0, late: 0, early: 0, full: 0 }],
    ]);

    for (const emp of roster) {
      const recMap = recByUser.get(emp.user_id) ?? new Map<string, DisciplineRec>();
      let absentDays = 0;
      let occurrences = 0;
      let prevAbsent = false;
      let lateMinutes = 0;
      let earlyMinutes = 0;
      let lateCount = 0;
      let earlyCount = 0;
      let fullDays = 0;

      for (const d of workdays) {
        const rec = recMap.get(d);
        if (!rec) {
          absentDays += 1;
          if (!prevAbsent) occurrences += 1;
          prevAbsent = true;
          continue;
        }
        prevAbsent = false;
        // Ngày nghỉ phép/thai sản: giờ vào/ra chỉ là mốc tượng trưng do duyệt đơn ghi → không tính trễ/sớm.
        const onLeave = rec.status === 'leave' || rec.status === 'maternity';
        const lm = onLeave ? 0 : calcLateMinutes(rec.check_in_at, lateAfter);
        if (lm > 0) {
          lateMinutes += lm;
          lateCount += 1;
        }
        const isApprovedEarly = approvedEarlySet.has(`${emp.user_id}:${d}`);
        if (rec.check_out_at && !isApprovedEarly && !onLeave) {
          const em = Math.max(0, workEndMin - vnClockMinutes(rec.check_out_at));
          if (em > 0) {
            earlyMinutes += em;
            earlyCount += 1;
          }
        }
        const hours = displayTotalHours(rec, shiftConfig);
        if (isApprovedEarly || (hours != null && hours >= fullDayMin)) fullDays += 1;
      }

      const gKey: 'M' | 'F' | 'unknown' =
        emp.gender === 'M' ? 'M' : emp.gender === 'F' ? 'F' : 'unknown';
      const acc = genderAcc.get(gKey)!;
      acc.headcount += 1;
      acc.absent += absentDays;
      acc.late += lateCount;
      acc.early += earlyCount;
      acc.full += fullDays;

      const teamName = emp.team_name ?? 'Chưa có quản lý';
      if (absentDays > 0) {
        absentRows.push({
          user_id: emp.user_id,
          full_name: emp.full_name,
          employee_code: emp.employee_code,
          team_name: teamName,
          position: emp.position,
          absent_days: absentDays,
          absent_occurrences: occurrences,
          absent_rate:
            totalWorkdays > 0 ? Math.round((absentDays / totalWorkdays) * 1000) / 10 : 0,
        });
      }
      const violation = lateMinutes + earlyMinutes;
      if (violation > 0) {
        violationRows.push({
          user_id: emp.user_id,
          full_name: emp.full_name,
          employee_code: emp.employee_code,
          team_name: teamName,
          position: emp.position,
          late_minutes: lateMinutes,
          early_minutes: earlyMinutes,
          violation_minutes: violation,
          late_count: lateCount,
          early_count: earlyCount,
        });
      }
    }

    const top_absent = absentRows
      .sort(
        (a, b) =>
          b.absent_days - a.absent_days ||
          b.absent_rate - a.absent_rate ||
          (a.full_name ?? '').localeCompare(b.full_name ?? ''),
      )
      .slice(0, 10);
    const top_violation = violationRows
      .sort(
        (a, b) =>
          b.violation_minutes - a.violation_minutes ||
          b.late_minutes - a.late_minutes ||
          (a.full_name ?? '').localeCompare(b.full_name ?? ''),
      )
      .slice(0, 10);

    const GENDER_LABEL: Record<'M' | 'F' | 'unknown', string> = {
      M: 'Nam',
      F: 'Nữ',
      unknown: 'Chưa xác định',
    };
    const by_gender: DisciplineGenderRow[] = (['M', 'F', 'unknown'] as const)
      .map((g): DisciplineGenderRow => {
        const acc = genderAcc.get(g)!;
        const denom = acc.headcount * totalWorkdays;
        const fullRate = denom > 0 ? Math.round((acc.full / denom) * 1000) / 10 : 0;
        return {
          gender: g,
          gender_label: GENDER_LABEL[g],
          headcount: acc.headcount,
          total_absent_days: acc.absent,
          total_late_count: acc.late,
          total_early_count: acc.early,
          full_attendance_rate: fullRate,
          insufficient_rate: Math.round((100 - fullRate) * 10) / 10,
        };
      })
      .filter((row) => row.headcount > 0);

    return {
      date_from: fromStr,
      date_to: toStr,
      work_end: shiftConfig.work_end,
      total_workdays: totalWorkdays,
      top_absent,
      top_violation,
      by_gender,
    };
  }

  /** Tuỳ chọn cho 3 bộ lọc multi-select (Phòng ban / Team / Văn phòng) — chỉ NV đang làm việc.
   *  Phòng ban + Team được scope theo team_lead (subtree); Văn phòng giữ toàn bộ (tên không nhạy
   *  cảm + dữ liệu thống kê đã scope server-side nên không leak). */
  async getStatsFilterOptions(
    scopeUserIds?: number[] | null,
  ): Promise<StatsFilterOptions> {
    const scope = buildScopeCondition(scopeUserIds);
    const scopeFrag = scope ? Prisma.sql`AND ${scope}` : Prisma.empty;
    // Team filter: nguồn CHÍNH THỨC = bảng teams (đồng bộ Cài đặt → Team + Quản lý nhân sự).
    // Admin (scope null) → MỌI team (kể cả 0 NV — yêu cầu hiển thị đủ team đã cấu hình).
    // quản lý (có scope) → chỉ team có ≥1 NV (resolve 3 tầng) trong subtree của họ.
    const teamsQuery = scope
      ? this.prisma.$queryRaw<Array<{ id: number; name: string }>>`
          SELECT DISTINCT t.id::int AS id, t.name AS name
          FROM employees e
          JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
          JOIN teams t ON t.id = ${RESOLVED_TEAM_ID_SQL}
          WHERE e.deleted_at IS NULL AND ${employedRosterCond(NOW_VN_DATE_SQL)} AND ${scope}
          ORDER BY name ASC
        `
      : this.prisma.$queryRaw<Array<{ id: number; name: string }>>`
          SELECT id::int AS id, name FROM teams ORDER BY name ASC
        `;
    const [depts, teams, offices] = await Promise.all([
      this.prisma.$queryRaw<Array<{ department: string }>>`
        SELECT DISTINCT COALESCE(NULLIF(TRIM(e.department), ''), 'Chưa phân phòng') AS department
        FROM employees e
        JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
        WHERE e.deleted_at IS NULL AND ${employedRosterCond(NOW_VN_DATE_SQL)} ${scopeFrag}
        ORDER BY department ASC
      `,
      teamsQuery,
      this.prisma.$queryRaw<Array<{ id: number; name: string }>>`
        SELECT id::int AS id, name
        FROM attendance_offices
        WHERE is_active = true
        ORDER BY name ASC
      `,
    ]);
    return {
      departments: depts.map((d) => d.department),
      // Append option ảo "Chưa có team" (sentinel -1) để lọc NV chưa thuộc team nào.
      teams: [
        ...teams.map((t) => ({ id: t.id, name: t.name })),
        { id: NO_TEAM_SENTINEL, name: 'Chưa có team' },
      ],
      offices: offices.map((o) => ({ id: o.id, name: o.name })),
    };
  }

  /**
   * Scope user ids cho thống kê + danh sách vắng theo phạm vi quyền `attendance.view`
   * — `null` = xem TOÀN BỘ NV
   * (scope `all`), mảng = giới hạn đúng tập user id trong scope (`own`/`team`/
   * `subtree`). Controller đã gác `@Can('attendance.view')` trước khi gọi tới đây
   * nên `ownerIds` luôn có giá trị (không `null` do thiếu quyền).
   */
  async resolveStatsScope(user: AuthUser): Promise<number[] | null> {
    const owner = await this.scope.ownerIds(user, 'attendance.view');
    return owner === 'all' || owner === null ? null : owner;
  }

  /**
   * Danh sách nhân viên VẮNG (chưa chấm CẢ vào lẫn ra) trong 1 NGÀY (giờ VN, YYYY-MM-DD).
   * Phạm vi = NV ĐANG LÀM VIỆC theo `employedRosterCond(${dateStr}::date)`: `status='active'`,
   * HOẶC `status='resigned'` mà `dateStr` còn TRƯỚC mốc `resigned_at` (giờ VN) — giữ lịch sử
   * các ngày trước khi nghỉ, chỉ loại NV KỂ TỪ ngày họ nghỉ + user chưa xoá. Vắng = KHÔNG tồn
   * tại bản ghi attendance nào trong ngày có check_in HOẶC check_out. Dùng cho bảng trong popup
   * Thống kê + xuất Excel. Cap ABSENT_EMPLOYEES_CAP.
   *
   * `sortBy` (whitelist `ABSENT_ORDER_COLUMNS`, mặc định = team) + `sortDir` (asc|desc) → sort
   * SERVER-SIDE để bảng FE và file Excel KHỚP TUYỆT ĐỐI (cùng 1 ORDER BY). Tiebreak `e.id`.
   * `team` = full_name của quản lý trực tiếp (users.manager_id); `team_id` = manager_id (tô màu).
   */
  async getAbsentEmployees(
    dateStr: string,
    sortBy?: string,
    sortDir?: string,
    scopeUserIds?: number[] | null,
  ): Promise<AbsentEmployee[]> {
    const orderCol = (sortBy && Object.hasOwn(ABSENT_ORDER_COLUMNS, sortBy) ? ABSENT_ORDER_COLUMNS[sortBy] : undefined) ??
      ABSENT_ORDER_COLUMNS[ABSENT_DEFAULT_SORT];
    const orderDir = sortDir === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const scope = buildScopeCondition(scopeUserIds);
    const scopeFrag = scope ? Prisma.sql`AND ${scope}` : Prisma.empty;
    return this.prisma.$queryRaw<AbsentEmployee[]>`
      SELECT
        u.id::int AS user_id,
        COALESCE(NULLIF(TRIM(e.employee_code), ''), 'NV' || LPAD(e.id::text, 4, '0')) AS employee_code,
        u.full_name AS full_name,
        u.email AS email,
        u.phone AS phone,
        NULLIF(TRIM(e.position), '') AS position,
        NULLIF(TRIM(e.department), '') AS department,
        e.gender AS gender,
        ao.name AS office_name,
        mgr.full_name AS team_name,
        u.manager_id::int AS team_id
      FROM employees e
      JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
      LEFT JOIN attendance_offices ao ON ao.id = e.office_id
      LEFT JOIN users mgr ON mgr.id = u.manager_id
      WHERE e.deleted_at IS NULL AND ${employedRosterCond(Prisma.sql`${dateStr}::date`)} ${scopeFrag}
        AND NOT EXISTS (
          SELECT 1 FROM attendance_records ar
          WHERE ar.user_id = e.user_id
            AND ar.work_date = ${dateStr}::date
            AND (ar.check_in_at IS NOT NULL OR ar.check_out_at IS NOT NULL)
        )
      ORDER BY ${orderCol} ${orderDir} NULLS LAST, u.full_name ASC, e.id ASC
      LIMIT ${ABSENT_EMPLOYEES_CAP}
    `;
  }

  // ============================================================
  // THỐNG KÊ GIỜ LÀM
  // ============================================================

  async getWeeklyStats(userId: number, isAdmin: boolean, targetUserId?: number) {
    const effectiveUserId = isAdmin && targetUserId ? targetUserId : userId;
    const today = new Date();
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      return getVnDateString(d);
    }).reverse();

    const fromDate = parseDateToUtcMidnight(dates[0]);
    const toDate = parseDateToUtcMidnight(dates[dates.length - 1]);

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        user_id: effectiveUserId,
        work_date: { gte: fromDate, lte: toDate },
      },
      select: { work_date: true, total_hours: true, status: true, check_in_at: true, check_out_at: true },
      orderBy: { work_date: 'asc' },
    });

    const recordsByDate = new Map(
      records.map((r) => [r.work_date.toISOString().slice(0, 10), r]),
    );

    const shiftConfig = await this.getShiftConfig();
    return dates.map((date) => {
      const rec = recordsByDate.get(date);
      return {
        date,
        // total_hours + status tính LẠI (KHÔNG tin giá trị lưu DB — stale). null khi không có bản ghi.
        total_hours: rec ? displayTotalHours(rec, shiftConfig) : null,
        status: rec ? displayStatus(rec, shiftConfig) : null,
        check_in_at: rec?.check_in_at ?? null,
        check_out_at: rec?.check_out_at ?? null,
      };
    });
  }

  async getMonthlyStats(userId: number, isAdmin: boolean, targetUserId?: number, month?: string) {
    const effectiveUserId = isAdmin && targetUserId ? targetUserId : userId;
    const now = new Date();
    const [y, m] = month
      ? month.split('-').map(Number)
      : getVnDateString(now).split('-').slice(0, 2).map(Number); // tháng hiện tại theo giờ VN

    const fromDate = parseDateToUtcMidnight(`${y}-${String(m).padStart(2, '0')}-01`);
    const lastDay = new Date(y, m, 0).getDate();
    const toDate = parseDateToUtcMidnight(`${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        user_id: effectiveUserId,
        work_date: { gte: fromDate, lte: toDate },
      },
      select: { total_hours: true, status: true, check_in_at: true, check_out_at: true },
    });

    // Tính LẠI status + đi muộn từ giờ chấm (KHÔNG tin status lưu DB — stale → "0 ngày công / 0 đi muộn").
    const shiftConfig = await this.getShiftConfig();
    const lateAfterMinutes = hmToMinutes(shiftConfig.late_after);
    const computed = records.map((r) => ({
      status: displayStatus(r, shiftConfig),
      isLate: calcLateMinutes(r.check_in_at, lateAfterMinutes) > 0,
      total_hours: displayTotalHours(r, shiftConfig),
    }));

    const totalHours = computed.reduce((s, r) => s + (r.total_hours ?? 0), 0);
    // Ngày công = đủ công/đi muộn (làm cả ngày) + nghỉ phép/thai sản (ngày được tính công).
    const presentDays = computed.filter((r) =>
      ['present', 'late', 'leave', 'maternity'].includes(r.status),
    ).length;
    // Đi muộn dựa late_minutes (giờ chấm VÀO) — đếm cả ngày chưa chấm ra.
    const lateDays = computed.filter((r) => r.isLate).length;
    const halfDays = computed.filter((r) => r.status === 'half_day').length;

    // Tổng giờ làm TOÀN BỘ nhân viên trong tháng — chỉ admin (super_admin/hr) mới có.
    // TÍNH LẠI từ giờ chấm (KHÔNG dùng _sum cột total_hours lưu DB — stale, chưa trừ nghỉ trưa).
    // attendance_records nhỏ (số NV × số ngày) nên nạp dòng + cộng app-layer an toàn.
    let companyTotalHours: number | null = null;
    if (isAdmin) {
      const allRecords = await this.prisma.attendanceRecord.findMany({
        where: { work_date: { gte: fromDate, lte: toDate } },
        select: { total_hours: true, status: true, check_in_at: true, check_out_at: true },
      });
      const sum = allRecords.reduce(
        (s, r) => s + (displayTotalHours(r, shiftConfig) ?? 0),
        0,
      );
      companyTotalHours = Math.round(sum * 100) / 100;
    }

    return {
      month: `${y}-${String(m).padStart(2, '0')}`,
      total_hours: Math.round(totalHours * 100) / 100,
      present_days: presentDays,
      late_days: lateDays,
      half_days: halfDays,
      records_count: records.length,
      // null cho role thường; số tổng cho super_admin/hr.
      company_total_hours: companyTotalHours,
    };
  }

  /**
   * Biểu đồ đường tổng giờ làm 7 ngày gần nhất:
   * - admin (super_admin/hr): TỔNG giờ làm của TẤT CẢ nhân viên theo ngày.
   * - role khác: tổng giờ làm CỦA CHÍNH MÌNH theo ngày.
   * total_hours chỉ có khi đã chấm ra → ngày chưa chấm ra = 0 (đúng nghiệp vụ).
   */
  async getWeeklyHoursChart(
    userId: number,
    isAdmin: boolean,
    dateFrom?: string,
    dateTo?: string,
  ) {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const MAX_RANGE_DAYS = 92;
    let fromStr: string;
    let toStr: string;
    if (dateFrom && dateTo && DATE_RE.test(dateFrom) && DATE_RE.test(dateTo)) {
      // Khoảng tuỳ chọn (hoán đổi nếu nhập ngược).
      [fromStr, toStr] = dateFrom <= dateTo ? [dateFrom, dateTo] : [dateTo, dateFrom];
    } else {
      // Mặc định 7 ngày gần nhất (giữ behavior cũ khi không truyền khoảng).
      const today = new Date();
      toStr = getVnDateString(today);
      const from = new Date(today);
      from.setDate(from.getDate() - 6);
      fromStr = getVnDateString(from);
    }
    // Sinh mảng ngày fromStr..toStr (inclusive) bằng số học UTC-midnight (tránh lệch tz);
    // clamp span ≤ MAX_RANGE_DAYS (giữ N ngày cuối kết thúc ở toStr).
    const toMid = parseDateToUtcMidnight(toStr);
    let dayCount =
      Math.floor(
        (toMid.getTime() - parseDateToUtcMidnight(fromStr).getTime()) / 86400000,
      ) + 1;
    if (dayCount > MAX_RANGE_DAYS) {
      fromStr = new Date(toMid.getTime() - (MAX_RANGE_DAYS - 1) * 86400000)
        .toISOString()
        .slice(0, 10);
      dayCount = MAX_RANGE_DAYS;
    }
    const startMid = parseDateToUtcMidnight(fromStr);
    const dates = Array.from({ length: dayCount }, (_, i) =>
      new Date(startMid.getTime() + i * 86400000).toISOString().slice(0, 10),
    );

    // TÍNH LẠI total_hours từ giờ chấm (KHÔNG SUM cột total_hours lưu DB — stale, chưa trừ
    // nghỉ trưa). attendance_records nhỏ (số NV × số ngày) nên nạp dòng + cộng app-layer.
    const shiftConfig = await this.getShiftConfig();
    const fromMid = parseDateToUtcMidnight(fromStr);
    const toMid2 = parseDateToUtcMidnight(toStr);

    if (isAdmin) {
      const rows = await this.prisma.attendanceRecord.findMany({
        where: { work_date: { gte: fromMid, lte: toMid2 } },
        select: { work_date: true, total_hours: true, status: true, check_in_at: true, check_out_at: true },
      });
      const byDay = new Map<string, number>();
      for (const r of rows) {
        const day = r.work_date.toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + (displayTotalHours(r, shiftConfig) ?? 0));
      }
      return {
        scope: 'all' as const,
        data: dates.map((date) => ({
          date,
          total_hours: Math.round((byDay.get(date) ?? 0) * 100) / 100,
        })),
      };
    }

    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        user_id: userId,
        work_date: { gte: fromMid, lte: toMid2 },
      },
      select: { work_date: true, total_hours: true, status: true, check_in_at: true, check_out_at: true },
    });
    const byDay = new Map(
      records.map((r) => [
        r.work_date.toISOString().slice(0, 10),
        Math.round((displayTotalHours(r, shiftConfig) ?? 0) * 100) / 100,
      ]),
    );
    return {
      scope: 'self' as const,
      data: dates.map((date) => ({ date, total_hours: byDay.get(date) ?? 0 })),
    };
  }

  // ============================================================
  // ĐƠN CHẤM CÔNG (ATTENDANCE REQUESTS)
  // ============================================================

  /** Lấy cấu hình giới hạn đơn chấm công. Fallback về DEFAULT_REQUEST_CONFIG nếu chưa set. */
  async getRequestConfig(): Promise<RequestConfig> {
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: ATTENDANCE_REQUEST_CFG_KEY },
        select: { value: true },
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value) as Partial<RequestConfig>;
        return {
          default_check_in:
            typeof parsed.default_check_in === 'string' && HM_RE.test(parsed.default_check_in)
              ? parsed.default_check_in
              : DEFAULT_REQUEST_CONFIG.default_check_in,
          default_check_out:
            typeof parsed.default_check_out === 'string' && HM_RE.test(parsed.default_check_out)
              ? parsed.default_check_out
              : DEFAULT_REQUEST_CONFIG.default_check_out,
          monthly_forgot_limit:
            typeof parsed.monthly_forgot_limit === 'number' && parsed.monthly_forgot_limit >= 0
              ? parsed.monthly_forgot_limit
              : DEFAULT_REQUEST_CONFIG.monthly_forgot_limit,
          monthly_late_early_limit:
            typeof parsed.monthly_late_early_limit === 'number' &&
            parsed.monthly_late_early_limit >= 0
              ? parsed.monthly_late_early_limit
              : DEFAULT_REQUEST_CONFIG.monthly_late_early_limit,
        };
      }
    } catch (err) {
      this.logger.error(`getRequestConfig failed: ${(err as Error)?.message}`);
    }
    return { ...DEFAULT_REQUEST_CONFIG };
  }

  /** Cập nhật cấu hình giới hạn đơn chấm công (super_admin). */
  async updateRequestConfig(dto: UpdateRequestConfigDto, userId: number): Promise<RequestConfig> {
    const next: RequestConfig = {
      default_check_in: dto.default_check_in,
      default_check_out: dto.default_check_out,
      monthly_forgot_limit: dto.monthly_forgot_limit,
      monthly_late_early_limit: dto.monthly_late_early_limit,
    };
    const value = JSON.stringify(next);
    await this.prisma.setting.upsert({
      where: { key: ATTENDANCE_REQUEST_CFG_KEY },
      update: { value, updated_by: userId },
      create: { key: ATTENDANCE_REQUEST_CFG_KEY, value, updated_by: userId },
    });
    this.logger.log(`Attendance request config updated by user ${userId}: ${value}`);
    return next;
  }

  /**
   * Áp giới hạn đơn theo tháng trong cấu hình (`monthly_forgot_limit` cho đơn quên check-in/out,
   * `monthly_late_early_limit` cho đơn đi muộn/về sớm; 0 = không giới hạn). Tháng tính theo ngày công của đơn;
   * đơn bị từ chối không tính vào hạn mức.
   */
  private async assertMonthlyRequestLimit(userId: number, type: string, workDate: Date): Promise<void> {
    const forgot = type === 'forgot_check_in' || type === 'forgot_check_out';
    const lateEarly = type === 'late_arrival' || type === 'early_leave';
    if (!forgot && !lateEarly) return;

    const cfg = await this.getRequestConfig();
    const limit = forgot ? cfg.monthly_forgot_limit : cfg.monthly_late_early_limit;
    if (!limit || limit <= 0) return;

    const y = workDate.getUTCFullYear();
    const m = workDate.getUTCMonth();
    const used = await this.prisma.attendanceRequest.count({
      where: {
        user_id: userId,
        type: { in: forgot ? ['forgot_check_in', 'forgot_check_out'] : ['late_arrival', 'early_leave'] },
        status: { in: ['pending', 'approved'] },
        work_date: { gte: new Date(Date.UTC(y, m, 1)), lt: new Date(Date.UTC(y, m + 1, 1)) },
      },
    });
    if (used >= limit) {
      const label = `${String(m + 1).padStart(2, '0')}/${y}`;
      throw new BadRequestException(
        forgot
          ? `Bạn đã dùng hết ${limit} lần quên chấm công của tháng ${label}. Vui lòng liên hệ quản lý/nhân sự.`
          : `Bạn đã dùng hết ${limit} lần đi trễ/về sớm của tháng ${label}. Vui lòng liên hệ quản lý/nhân sự.`,
      );
    }
  }

  /** Nhân viên gửi đơn chấm công mới. */
  async createRequest(
    userId: number,
    dto: CreateAttendanceRequestDto,
  ): Promise<AttendanceRequestDto> {
    // Validate: forgot_check_in → bắt buộc requested_check_in
    if (dto.type === 'forgot_check_in' && !dto.requested_check_in) {
      throw new BadRequestException(
        'Vui lòng nhập giờ check-in đề nghị (requested_check_in) cho đơn quên check-in.',
      );
    }
    if (dto.type === 'forgot_check_out' && !dto.requested_check_out) {
      throw new BadRequestException(
        'Vui lòng nhập giờ check-out đề nghị (requested_check_out) cho đơn quên check-out.',
      );
    }

    const workDate = parseDateToUtcMidnight(dto.work_date);

    await this.assertMonthlyRequestLimit(userId, dto.type, workDate);

    const request = await this.prisma.attendanceRequest.create({
      data: {
        user_id: userId,
        work_date: workDate,
        type: dto.type,
        requested_check_in: dto.requested_check_in ?? null,
        requested_check_out: dto.requested_check_out ?? null,
        reason: dto.reason,
        status: 'pending',
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { full_name: true, email: true },
    });
    const userName = user?.full_name ?? user?.email ?? String(userId);

    // Thông báo cho super_admin + hr (người duyệt đơn). Fire-and-forget:
    // lỗi notify KHÔNG được ảnh hưởng tới việc tạo đơn.
    runInBackground(
      () =>
        this.notifyAttendanceRequestCreated({
          requestId: request.id,
          type: dto.type,
          workDate: dto.work_date,
          userName,
          reason: dto.reason,
        }),
      (err) =>
        this.logger.warn(
          `notifyAttendanceRequestCreated failed for request ${request.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
    );

    return this.mapRequest(request, userName, null);
  }

  /**
   * Gửi thông báo in-app tới nhóm giữ quyền `attendance.manage` (duyệt đơn) khi
   * nhân viên tạo đơn chấm công mới. Click thông báo dẫn tới `/management/workdays` (tab
   * "Quản lý đơn"). Tái dùng `NotificationsService.createPendingLogs` (retry + dedupe +
   * WebSocket push). Gọi fire-and-forget từ `createRequest`.
   */
  private async notifyAttendanceRequestCreated(params: {
    requestId: number;
    type: string;
    workDate: string; // YYYY-MM-DD
    userName: string;
    reason: string;
  }): Promise<void> {
    const recipientIds = await findUserIdsWithPermission(this.prisma, 'attendance.manage');
    if (recipientIds.length === 0) return;

    const typeLabel =
      ATTENDANCE_REQUEST_TYPE_LABEL[params.type] ?? 'Đơn chấm công';
    const [y, m, d] = params.workDate.split('-');
    const dateLabel = y && m && d ? `${d}/${m}/${y}` : params.workDate;
    const reasonPreview = params.reason.trim().slice(0, 100);

    await this.notifications.createPendingLogs(
      recipientIds,
      'attendance.request.created',
      {
        title: `Đơn chấm công mới • ${typeLabel}`,
        body: `${params.userName} — ngày ${dateLabel}: ${reasonPreview}`,
        action_url: '/management/workdays',
      },
    );
  }

  /** Danh sách đơn chấm công — admin thấy tất cả, nhân viên chỉ thấy của mình. */
  async listRequests(
    userId: number,
    ownerIds: number[] | 'all',
    dto: QueryAttendanceRequestsDto,
  ): Promise<{ data: AttendanceRequestDto[]; total: number; page: number; page_size: number }> {
    const page = Math.max(1, dto.page ?? 1);
    // Admin panel gửi page_size=1000 để tải hết rồi lọc client-side — cho phép tối đa 2000 đơn.
    const pageSize = Math.min(2000, Math.max(1, dto.page_size ?? 20));
    const skip = (page - 1) * pageSize;

    const where: Prisma.AttendanceRequestWhereInput = {};
    if (ownerIds !== 'all') where.user_id = { in: ownerIds };
    if (dto.status) where.status = dto.status;

    // lọc theo Team / Phòng ban / Chức danh qua employee relation.
    // Team_id KHÔNG lọc trực tiếp cột thô `employees.team_id` (bug gốc —
    // xem JSDoc `resolveTeamMemberUserIds`) — resolve 3 tầng rồi giao (AND) với
    // `where.user_id` đã có (IDOR self-scope) qua `intersectUserIdFilter`.
    const reqEmployeeWhere: Record<string, unknown> = {};
    if (dto.department?.trim()) reqEmployeeWhere['department'] = dto.department.trim();
    if (dto.job_title_id) reqEmployeeWhere['job_title_id'] = dto.job_title_id;
    if (Object.keys(reqEmployeeWhere).length > 0) {
      (where as Record<string, unknown>)['user'] = { employee: reqEmployeeWhere };
    }
    if (dto.team_id) {
      const teamUserIds = await resolveTeamMemberUserIds(this.prisma, dto.team_id);
      (where as Record<string, unknown>)['user_id'] = intersectUserIdFilter(
        where.user_id,
        teamUserIds,
      );
    }

    const [total, rows] = await Promise.all([
      this.prisma.attendanceRequest.count({ where }),
      this.prisma.attendanceRequest.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: pageSize,
      }),
    ]);

    // Batch lookup tên người dùng — KHÔNG N+1
    const allUserIds = [
      ...new Set([
        ...rows.map((r) => r.user_id),
        ...rows.map((r) => r.reviewed_by).filter((id): id is number => id !== null),
      ]),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: allUserIds } },
      select: {
        id: true,
        full_name: true,
        email: true,
        manager_id: true,
        employee: { select: { team_id: true } },
      },
    });
    const nameMap = new Map(users.map((u) => [u.id, u.full_name ?? u.email ?? String(u.id)]));

    // cột "Team" — resolve 3 tầng CHÍNH THỨC (mirror listRecords/getWorkdaysMatrix).
    const orgLookup = await loadTeamOrgLookup(this.prisma);
    const teamNameByUserId = new Map(
      users.map((u) => [
        u.id,
        resolveTeamName(
          {
            id: u.id,
            manager_id: u.manager_id,
            full_name: u.full_name,
            employee: u.employee ? { team_id: u.employee.team_id, department: null, jobTitle: null } : null,
          },
          orgLookup,
        ),
      ]),
    );

    const data = rows.map((r) =>
      this.mapRequest(
        r,
        nameMap.get(r.user_id) ?? String(r.user_id),
        r.reviewed_by ? (nameMap.get(r.reviewed_by) ?? null) : null,
        teamNameByUserId.get(r.user_id) ?? null,
      ),
    );

    return { data, total, page, page_size: pageSize };
  }

  /** HR duyệt đơn và cập nhật bản ghi chấm công tương ứng (transaction). */
  async approveRequest(
    requestId: number,
    reviewerId: number,
    ownerIds: number[] | 'all',
  ): Promise<AttendanceRequestDto> {
    const req = await this.prisma.attendanceRequest.findUnique({ where: { id: requestId } });
    if (!req || (ownerIds !== 'all' && !ownerIds.includes(req.user_id))) {
      throw new NotFoundException('Không tìm thấy đơn chấm công.');
    }
    if (req.status !== 'pending') {
      throw new BadRequestException(`Đơn đã được xử lý (trạng thái: ${req.status}).`);
    }

    const shiftConfig = await this.getShiftConfig();
    const lateAfterMinutes = hmToMinutes(shiftConfig.late_after);
    const lunchWindow = { start: shiftConfig.lunch_start, end: shiftConfig.lunch_end };
    const reqConfig = await this.getRequestConfig();

    const updatedRequest = await this.prisma.$transaction(async (tx) => {
      // Cập nhật trạng thái đơn
      const updated = await tx.attendanceRequest.update({
        where: { id: requestId },
        data: { status: 'approved', reviewed_by: reviewerId, reviewed_at: new Date() },
      });

      // Áp dụng hiệu lực lên attendance_records theo type
      if (req.type === 'forgot_check_in' || req.type === 'forgot_check_out') {
        // Xác định giờ check-in/check-out để upsert
        const checkInHm =
          req.type === 'forgot_check_in'
            ? (req.requested_check_in ?? reqConfig.default_check_in)
            : null;
        const checkOutHm =
          req.type === 'forgot_check_out'
            ? (req.requested_check_out ?? reqConfig.default_check_out)
            : null;

        // Load bản ghi hiện tại (nếu có) để tính lại
        const existing = await tx.attendanceRecord.findUnique({
          where: { user_id_work_date: { user_id: req.user_id, work_date: req.work_date } },
        });

        // Tính thời điểm UTC
        const newCheckIn = checkInHm ? vnTimeToInstant(req.work_date, checkInHm) : (existing?.check_in_at ?? null);
        const newCheckOut = checkOutHm ? vnTimeToInstant(req.work_date, checkOutHm) : (existing?.check_out_at ?? null);

        // Tính lại các trường phái sinh
        const lateMinutes = calcLateMinutes(newCheckIn, lateAfterMinutes);
        const totalHours = calcTotalHours(newCheckIn, newCheckOut, lunchWindow);
        const status = calcStatus(
          newCheckIn,
          newCheckOut,
          lunchWindow,
          shiftConfig.review_max_hours,
          shiftConfig.half_day_min_hours,
          shiftConfig.full_day_min_hours,
        );

        // Load employee_id nếu chưa có
        const employee = await tx.employee.findUnique({
          where: { user_id: req.user_id },
          select: { id: true },
        });

        await tx.attendanceRecord.upsert({
          where: { user_id_work_date: { user_id: req.user_id, work_date: req.work_date } },
          create: {
            user_id: req.user_id,
            employee_id: employee?.id ?? null,
            work_date: req.work_date,
            check_in_at: newCheckIn,
            check_out_at: newCheckOut,
            late_minutes: lateMinutes,
            total_hours: totalHours ?? undefined,
            status,
          },
          update: {
            ...(checkInHm ? { check_in_at: newCheckIn } : {}),
            ...(checkOutHm ? { check_out_at: newCheckOut } : {}),
            late_minutes: lateMinutes,
            total_hours: totalHours ?? undefined,
            status,
          },
        });
      } else if (req.type === 'leave' || req.type === 'maternity') {
        // Nghỉ phép / thai sản = NGÀY CÔNG ĐỦ (8 tiếng). Đặt giờ chuẩn 08:00–17:30 (config đơn)
        // + total_hours = 8 để báo cáo tuần/tháng tính đủ; late_minutes = 0 (không tính muộn);
        // status = leave/maternity (displayStatus GIỮ NGUYÊN, không suy lại từ giờ).
        const employee = await tx.employee.findUnique({
          where: { user_id: req.user_id },
          select: { id: true },
        });
        const leaveCheckIn = vnTimeToInstant(req.work_date, reqConfig.default_check_in);
        const leaveCheckOut = vnTimeToInstant(req.work_date, reqConfig.default_check_out);
        await tx.attendanceRecord.upsert({
          where: { user_id_work_date: { user_id: req.user_id, work_date: req.work_date } },
          create: {
            user_id: req.user_id,
            employee_id: employee?.id ?? null,
            work_date: req.work_date,
            check_in_at: leaveCheckIn,
            check_out_at: leaveCheckOut,
            total_hours: STANDARD_WORK_HOURS,
            late_minutes: 0,
            status: req.type,
          },
          update: {
            check_in_at: leaveCheckIn,
            check_out_at: leaveCheckOut,
            total_hours: STANDARD_WORK_HOURS,
            late_minutes: 0,
            status: req.type,
          },
        });
      }
      // late_arrival / early_leave: không chỉnh attendance_records

      return updated;
    });

    const [requester, reviewer] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: req.user_id },
        select: { full_name: true, email: true },
      }),
      this.prisma.user.findUnique({
        where: { id: reviewerId },
        select: { full_name: true, email: true },
      }),
    ]);

    return this.mapRequest(
      updatedRequest,
      requester?.full_name ?? requester?.email ?? String(req.user_id),
      reviewer?.full_name ?? reviewer?.email ?? null,
    );
  }

  /** HR từ chối đơn chấm công. */
  async rejectRequest(
    requestId: number,
    reviewerId: number,
    dto: RejectRequestDto,
    ownerIds: number[] | 'all',
  ): Promise<AttendanceRequestDto> {
    const req = await this.prisma.attendanceRequest.findUnique({ where: { id: requestId } });
    if (!req || (ownerIds !== 'all' && !ownerIds.includes(req.user_id))) {
      throw new NotFoundException('Không tìm thấy đơn chấm công.');
    }
    if (req.status !== 'pending') {
      throw new BadRequestException(`Đơn đã được xử lý (trạng thái: ${req.status}).`);
    }

    const updated = await this.prisma.attendanceRequest.update({
      where: { id: requestId },
      data: {
        status: 'rejected',
        reviewed_by: reviewerId,
        reviewed_at: new Date(),
        review_note: dto.review_note ?? null,
      },
    });

    const [requester, reviewer] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: req.user_id },
        select: { full_name: true, email: true },
      }),
      this.prisma.user.findUnique({
        where: { id: reviewerId },
        select: { full_name: true, email: true },
      }),
    ]);

    return this.mapRequest(
      updated,
      requester?.full_name ?? requester?.email ?? String(req.user_id),
      reviewer?.full_name ?? reviewer?.email ?? null,
    );
  }

  /** Map Prisma AttendanceRequest sang DTO an toàn (không expose raw DB row). */
  mapRequest(
    r: {
      id: number;
      user_id: number;
      work_date: Date;
      type: string;
      requested_check_in: string | null;
      requested_check_out: string | null;
      reason: string;
      status: string;
      reviewed_by: number | null;
      reviewed_at: Date | null;
      review_note: string | null;
      created_at: Date;
    },
    userName: string,
    reviewerName: string | null,
    teamName: string | null = null,
  ): AttendanceRequestDto {
    return {
      id: r.id,
      user_id: r.user_id,
      user_name: userName,
      work_date: r.work_date.toISOString().slice(0, 10),
      type: r.type,
      requested_check_in: r.requested_check_in,
      requested_check_out: r.requested_check_out,
      reason: r.reason,
      status: r.status,
      reviewed_by: r.reviewed_by,
      reviewer_name: reviewerName,
      reviewed_at: r.reviewed_at,
      review_note: r.review_note,
      created_at: r.created_at,
      team_name: teamName,
    };
  }
}
