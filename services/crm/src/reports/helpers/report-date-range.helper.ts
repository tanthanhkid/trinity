import { BadRequestException } from '@nestjs/common';
import { parseVnDateRange } from '../../common/helpers/parse-vn-date-range.helper';

/** [dateFrom, dateTo] đã parse theo giờ VN (dateFrom 00:00, dateTo 23:59:59.999). */
export interface ReportPeriod {
  dateFrom: Date;
  dateTo: Date;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse `date_from`/`date_to` (bắt buộc, `YYYY-MM-DD`, FE luôn gửi cả 2 —
 * `DateRangeFilter` mặc định "hôm nay") theo giờ VN. `strict=true` của
 * `parseVnDateRange` throw 400 khi sai định dạng.
 */
export function parseReportPeriod(
  dateFrom: string | undefined,
  dateTo: string | undefined,
): ReportPeriod {
  if (!dateFrom || !DATE_ONLY.test(dateFrom)) {
    throw new BadRequestException('date_from phải đúng định dạng YYYY-MM-DD');
  }
  if (!dateTo || !DATE_ONLY.test(dateTo)) {
    throw new BadRequestException('date_to phải đúng định dạng YYYY-MM-DD');
  }
  const { dateFrom: from, dateTo: to } = parseVnDateRange(dateFrom, dateTo, 0, true);
  if (from > to) {
    throw new BadRequestException(
      'Khoảng ngày không hợp lệ: ngày bắt đầu sau ngày kết thúc',
    );
  }
  return { dateFrom: from, dateTo: to };
}

/**
 * Kỳ TRƯỚC liền kề, cùng độ dài (mili giây) với kỳ hiện tại — dùng cho so
 * sánh delta ở Tổng quan/Kênh tương tác. Vd kỳ hiện tại 01/09–07/09 (7 ngày)
 * → kỳ trước 25/08–31/08 (cũng 7 ngày, kết thúc ngay trước kỳ hiện tại).
 */
export function computePreviousPeriod(period: ReportPeriod): ReportPeriod {
  const lengthMs = period.dateTo.getTime() - period.dateFrom.getTime() + 1;
  const dateTo = new Date(period.dateFrom.getTime() - 1);
  const dateFrom = new Date(dateTo.getTime() - lengthMs + 1);
  return { dateFrom, dateTo };
}

/** So sánh current/previous — `delta_pct = null` khi previous = 0 (tránh chia 0). */
export interface DeltaMetric {
  current: number;
  previous: number;
  delta_abs: number;
  delta_pct: number | null;
}

export function buildDeltaMetric(current: number, previous: number): DeltaMetric {
  const delta_abs = current - previous;
  const delta_pct = previous === 0 ? null : Number(((delta_abs / previous) * 100).toFixed(1));
  return { current, previous, delta_abs, delta_pct };
}
