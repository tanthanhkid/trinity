export type ReportBucketGranularity = 'day' | 'week' | 'month';

export interface ReportBucket {
  /** Nhãn hiển thị FE (`dd/MM` cho day/week, `MM/yyyy` cho month). */
  label: string;
  start: Date;
  end: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Chọn độ chi tiết bucket theo độ dài kỳ báo cáo — tránh trả về hàng trăm
 * điểm dữ liệu cho biểu đồ khi user chọn khoảng nhiều tháng/năm.
 */
export function pickBucketGranularity(
  dateFrom: Date,
  dateTo: Date,
): ReportBucketGranularity {
  const days = Math.ceil((dateTo.getTime() - dateFrom.getTime()) / DAY_MS);
  if (days <= 31) return 'day';
  if (days <= 180) return 'week';
  return 'month';
}

/** Định dạng nhãn VN cho 1 bucket (KHÔNG dùng `toLocaleDateString`). */
function formatVnLabel(date: Date, granularity: ReportBucketGranularity): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  if (granularity === 'month') return `${map.month}/${map.year}`;
  return `${map.day}/${map.month}`;
}

/**
 * Chia [dateFrom, dateTo] thành các bucket liên tiếp theo `granularity`.
 * Mốc bucket tính theo NGÀY VN (Asia/Ho_Chi_Minh) — bucket cuối cắt đúng
 * `dateTo` (không tràn quá kỳ báo cáo).
 */
export function buildReportBuckets(
  dateFrom: Date,
  dateTo: Date,
  granularity: ReportBucketGranularity,
): ReportBucket[] {
  const stepMs = granularity === 'day' ? DAY_MS : granularity === 'week' ? DAY_MS * 7 : 0;
  const buckets: ReportBucket[] = [];
  let cursor = new Date(dateFrom);
  // Neo theo ngày bắt đầu kỳ (không theo cursor đã bị kẹp) để 31/01 → 28/02 → 31/03, không trôi về 28.
  const anchorDay = new Date(dateFrom.getTime() + 7 * 60 * 60 * 1000).getUTCDate();

  while (cursor.getTime() <= dateTo.getTime()) {
    const end =
      granularity === 'month'
        ? addMonthsVn(cursor, anchorDay)
        : new Date(Math.min(cursor.getTime() + stepMs, dateTo.getTime() + 1));
    const clampedEnd = new Date(Math.min(end.getTime(), dateTo.getTime() + 1));
    buckets.push({ label: formatVnLabel(cursor, granularity), start: cursor, end: clampedEnd });
    cursor = clampedEnd;
  }
  return buckets;
}

/** +1 tháng dương lịch, giữ nguyên giờ VN trong ngày (áp dụng cho granularity='month'). */
function addMonthsVn(date: Date, anchorDay: number): Date {
  const vn = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  // Kẹp ngày về ngày cuối của tháng đích: 31/01 + 1 tháng = 28/02, không tràn sang 03/03.
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth() + 1;
  const day = Math.min(anchorDay, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  const next = new Date(Date.UTC(y, m, day));
  return new Date(next.getTime() - 7 * 60 * 60 * 1000);
}
