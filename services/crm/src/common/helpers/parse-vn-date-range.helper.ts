import { BadRequestException } from '@nestjs/common'

/**
 * Parse date range theo timezone VN (UTC+7) cho CRM reports.
 *
 * UI hiện luôn là VN nên người dùng chọn `2026-05-10` nghĩa là từ
 * `2026-05-10 00:00:00 +07:00` đến `2026-05-10 23:59:59.999 +07:00`.
 *
 * Trước fix backend parse `new Date('2026-05-10')` → UTC 00:00 → query
 * `2026-05-10 07:00 VN`, làm thiếu 7 giờ đầu ngày (vd: một deal chốt lúc
 * 02:00 VN = 19:00 UTC ngày 09 → bị loại khỏi kết quả).
 *
 * @param from `YYYY-MM-DD` (optional, dùng `defaultDays` nếu không có)
 * @param to `YYYY-MM-DD` (optional, dùng `now` nếu không có)
 * @param defaultDays Số ngày mặc định lùi từ `now` khi `from` không có
 * @param strict Nếu true → throw BadRequestException khi format sai
 */
export function parseVnDateRange(
  from: string | undefined,
  to: string | undefined,
  defaultDays: number,
  strict = false,
): { dateFrom: Date; dateTo: Date } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/
  if (strict) {
    if (from && !dateOnly.test(from)) {
      throw new BadRequestException('date_from phai dung dinh dang YYYY-MM-DD')
    }
    if (to && !dateOnly.test(to)) {
      throw new BadRequestException('date_to phai dung dinh dang YYYY-MM-DD')
    }
  }

  const dateFrom =
    from && dateOnly.test(from)
      ? new Date(`${from}T00:00:00+07:00`)
      : new Date(Date.now() - defaultDays * 24 * 60 * 60 * 1000)

  const dateTo =
    to && dateOnly.test(to) ? new Date(`${to}T23:59:59.999+07:00`) : new Date()

  return { dateFrom, dateTo }
}

/**
 * Mặc định khoảng ngày = 7 ngày gần nhất (giờ VN) khi client không truyền
 * `date_from`/`date_to`. Hàm THUẦN, dùng cho báo cáo
 * Marketing theo tài khoản (tuyển dụng).
 */
export function buildFilterDates(
  date_from?: string,
  date_to?: string,
): { dateFrom: Date; dateTo: Date } {
  const DEFAULT_DAYS = 7
  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date())
  const d = new Date(`${todayStr}T00:00:00+07:00`)
  d.setDate(d.getDate() - DEFAULT_DAYS)
  const defaultFrom = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(d)

  const from = date_from ?? defaultFrom
  const to = date_to ?? todayStr
  return parseVnDateRange(from, to, DEFAULT_DAYS)
}

/**
 * Biến thể KHÔNG ép khoảng mặc định — trả `undefined` cho biên nào
 * người dùng không chọn.
 *
 * ⚠️ Vì sao KHÔNG tái dùng `parseVnDateRange` ở trên cho màn danh sách: hàm đó
 * LUÔN sinh đủ 2 biên (`from` thiếu → lùi `defaultDays`, `to` thiếu → `now`).
 * Áp vào danh sách/xuất Excel sẽ **âm thầm cắt mất bản ghi cũ** khi người
 * dùng chưa chọn ngày — màn danh sách phải liệt kê TOÀN BỘ.
 *
 * Giữ CHUNG file với `parseVnDateRange` để quy ước `+07:00` chỉ tồn tại ở MỘT
 * nơi — `new Date('YYYY-MM-DD')` parse ra UTC 00:00, mất 7 giờ đầu
 * ngày theo giờ VN.
 */
export function parseVnDateRangeOptional(
  from: string | undefined,
  to: string | undefined,
): { dateFrom?: Date; dateTo?: Date } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/
  if (from && !dateOnly.test(from)) {
    throw new BadRequestException('date_from phải đúng định dạng YYYY-MM-DD')
  }
  if (to && !dateOnly.test(to)) {
    throw new BadRequestException('date_to phải đúng định dạng YYYY-MM-DD')
  }
  const dateFrom = from ? new Date(`${from}T00:00:00+07:00`) : undefined
  const dateTo = to ? new Date(`${to}T23:59:59.999+07:00`) : undefined
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new BadRequestException('Khoảng ngày không hợp lệ: ngày bắt đầu sau ngày kết thúc')
  }
  return { dateFrom, dateTo }
}

/** Dựng mệnh đề Prisma cho `created_at`; trả `undefined` khi không chọn ngày nào. */
export function buildVnCreatedAtFilter(
  from: string | undefined,
  to: string | undefined,
): { gte?: Date; lte?: Date } | undefined {
  const { dateFrom, dateTo } = parseVnDateRangeOptional(from, to)
  if (!dateFrom && !dateTo) return undefined
  return { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) }
}
