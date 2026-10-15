/** Tiện ích thời gian VN (UTC+7) cho dashboard Tổng quan. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface VnRange {
  start: Date;
  end: Date;
}

/** Đầu tháng VN cách hiện tại `monthsAgo` tháng (0 = tháng này) → [start, end). */
export function vnMonthRange(monthsAgo: number, now = new Date()): VnRange {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth() - monthsAgo;
  return {
    start: new Date(Date.UTC(y, m, 1) - VN_OFFSET_MS),
    end: new Date(Date.UTC(y, m + 1, 1) - VN_OFFSET_MS),
  };
}

/** Nhãn "MM/YYYY" của tháng VN cách hiện tại `monthsAgo` tháng. */
export function vnMonthLabel(monthsAgo: number, now = new Date()): string {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const d = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth() - monthsAgo, 1));
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/** [00:00 hôm nay, 00:00 ngày mai) theo giờ VN. */
export function vnTodayRange(now = new Date()): VnRange {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const start = new Date(
    Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - VN_OFFSET_MS,
  );
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}
