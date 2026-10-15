/**
 * attendance-matrix.helper.ts — Pure helpers cho bảng chấm công tháng (lưới NV × ngày).
 * Unit-tested. KHÔNG import PrismaService hoặc các module NestJS.
 */

export const MATRIX_RECORD_CAP = 20000;

export type DayCell = {
  day: number;
  status: string;
  hours: number | null;
  late_minutes: number;
  check_in: string | null;
  check_out: string | null;
  /** Ngày half_day (4–8h) có đơn "Xin về sớm" đã DUYỆT → được bù thành đủ công. */
  early_leave_compensated?: boolean;
};

export type MatrixRow = {
  user_id: number;
  full_name: string | null;
  email: string | null;
  employee_code: string | null;
  position: string | null;
  department: string | null;
  /** Team CHÍNH THỨC resolve 3 tầng — null = "Chưa có team". */
  team_name: string | null;
  total_work_days: number;
  /** Công sau khi áp các đơn về sớm đã duyệt = total_work_days + 0.5 × compensated_days. */
  total_work_days_after_approval: number;
  total_hours: number;
  present_days: number;
  half_days: number;
  insufficient_days: number;
  incomplete_days: number;
  leave_days: number;
  maternity_days: number;
  late_days: number;
  total_late_minutes: number;
  /** Tổng số đơn về sớm (mọi trạng thái) NV nộp trong kỳ. */
  early_leave_count: number;
  /** Số đơn về sớm đã được duyệt. */
  early_leave_approved: number;
  /** Số đơn về sớm bị từ chối. */
  early_leave_rejected: number;
  /** Tổng phút thiếu so với đủ công (8h) trên các ngày NV về sớm. */
  early_leave_minutes: number;
  /** Số ngày half_day đã được bù công nhờ đơn về sớm duyệt (đưa total_work_days_after_approval lên). */
  compensated_days: number;
  notes: string;
  cells: Record<number, DayCell>;
};

/** hours → "H:MM" (vd 8.5→"8:30", 4→"4:00"). null → "" */
export function formatHm(hours: number | null): string {
  if (hours === null) return '';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  const mm = m < 10 ? `0${m}` : `${m}`;
  return `${h}:${mm}`;
}

/**
 * Date → HH:mm theo giờ VN (Asia/Ho_Chi_Minh).
 * KHÔNG dùng getHours()/getUTCHours() — sai timezone.
 */
export function vnHhmm(d: Date | null): string | null {
  if (!d) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export const STANDARD_DAY_TEXT = '8:00';

/**
 * Văn bản hiển thị trong ô ngày (Excel + FE phải đồng bộ logic).
 * present/leave/maternity → "8:00"; half_day/insufficient/review → formatHm(hours);
 * incomplete → "???"; mặc định → "·".
 */
export function cellDisplayText(status: string, hours: number | null): string {
  switch (status) {
    case 'present':
    case 'leave':
    case 'maternity':
      return STANDARD_DAY_TEXT;
    case 'half_day':
    case 'insufficient':
    case 'review':
      return formatHm(hours);
    case 'incomplete':
      return '???';
    default:
      return '·';
  }
}

/**
 * Ghi chú bất thường ngày công (ghép bằng " · " các phần > 0).
 */
export function computeNotes(r: {
  incomplete_days: number;
  half_days: number;
  insufficient_days: number;
  late_days: number;
}): string {
  const parts: string[] = [];
  if (r.incomplete_days > 0) parts.push(`Thiếu vào/ra: ${r.incomplete_days} ngày`);
  const under = r.half_days + r.insufficient_days;
  if (under > 0) parts.push(`Chưa đủ công: ${under} ngày`);
  if (r.late_days > 0) parts.push(`Đi muộn: ${r.late_days} lần`);
  return parts.join(' · ');
}

/**
 * Số ngày trong tháng từ date_from (dạng "YYYY-MM-DD").
 * date_from = "2026-06-01" → m=6, Date.UTC(2026, 6, 0) = ngày cuối tháng 6 = 30.
 */
export function daysInMonthFromDateFrom(dateFrom: string): number {
  const [y, m] = dateFrom.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * ARGB fill cho ô ngày trong Excel.
 * null = trắng (present đúng giờ); giá trị khác = màu fill.
 */
export const STATUS_FILL: Record<string, string | null> = {
  present_ontime: null,
  present_late: 'FFFFF3CD',
  under_full: 'FFFFE0B2',
  incomplete: 'FFFFF59D',
  leave: 'FFE1BEE7',
  maternity: 'FFF8BBD0',
  none: 'FFF1F5F9',
};

/** Xác định fill key cho 1 ô ngày (dùng trong export Excel). */
export function resolveFillKey(status: string, lateMinutes: number): string {
  if (!status || status === '') return 'none';
  if (status === 'present') return lateMinutes > 0 ? 'present_late' : 'present_ontime';
  if (status === 'half_day' || status === 'insufficient' || status === 'review')
    return 'under_full';
  if (status === 'incomplete') return 'incomplete';
  if (status === 'leave') return 'leave';
  if (status === 'maternity') return 'maternity';
  return 'none';
}
