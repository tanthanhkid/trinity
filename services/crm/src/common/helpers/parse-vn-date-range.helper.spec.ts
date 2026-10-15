import { BadRequestException } from '@nestjs/common'
import { parseVnDateRange } from './parse-vn-date-range.helper'

describe('parseVnDateRange', () => {
  it('parses date_only "from" as 00:00 VN (UTC+7) — fix', () => {
    const { dateFrom } = parseVnDateRange('2026-05-10', undefined, 30)
    // 2026-05-10 00:00:00 +07:00 === 2026-05-09 17:00:00 UTC
    expect(dateFrom.toISOString()).toBe('2026-05-09T17:00:00.000Z')
  })

  it('parses date_only "to" as 23:59:59.999 VN (UTC+7) — fix', () => {
    const { dateTo } = parseVnDateRange(undefined, '2026-05-10', 30)
    // 2026-05-10 23:59:59.999 +07:00 === 2026-05-10 16:59:59.999 UTC
    expect(dateTo.toISOString()).toBe('2026-05-10T16:59:59.999Z')
  })

  it('acceptance: bản ghi lúc 2026-05-10 02:00 VN nằm trong [from=2026-05-10, to=2026-05-10]', () => {
    const { dateFrom, dateTo } = parseVnDateRange('2026-05-10', '2026-05-10', 30)
    // Sự kiện lúc 2026-05-10 02:00 VN = 2026-05-09 19:00 UTC
    const eventUtc = new Date('2026-05-09T19:00:00.000Z')
    expect(eventUtc.getTime()).toBeGreaterThanOrEqual(dateFrom.getTime())
    expect(eventUtc.getTime()).toBeLessThanOrEqual(dateTo.getTime())
  })

  it('Parse theo UTC (sai): nếu parse theo UTC thì bản ghi lúc 02:00 VN sẽ rớt khỏi range', () => {
    // Reproduce bug cũ: from = '2026-05-10' → 2026-05-10 00:00 UTC = 2026-05-10 07:00 VN
    const buggyFrom = new Date('2026-05-10T00:00:00.000Z')
    const eventUtc = new Date('2026-05-09T19:00:00.000Z')
    // Thời điểm < buggyFrom → bị loại
    expect(eventUtc.getTime()).toBeLessThan(buggyFrom.getTime())
  })

  it('falls back to defaultDays when "from" empty', () => {
    const { dateFrom, dateTo } = parseVnDateRange(undefined, undefined, 30)
    const diffMs = dateTo.getTime() - dateFrom.getTime()
    // ~30 days (cho phép sai số do thời điểm chạy)
    expect(diffMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000)
    expect(diffMs).toBeLessThan(31 * 24 * 60 * 60 * 1000)
  })

  it('strict mode throws BadRequestException for invalid date_from format', () => {
    expect(() => parseVnDateRange('2026/05/10', undefined, 30, true)).toThrow(
      BadRequestException,
    )
  })

  it('strict mode throws BadRequestException for invalid date_to format', () => {
    expect(() => parseVnDateRange(undefined, 'bad-input', 30, true)).toThrow(
      BadRequestException,
    )
  })

  it('non-strict mode silently ignores invalid format and falls back', () => {
    const { dateFrom, dateTo } = parseVnDateRange('bad', 'bad', 7)
    // Không throw, fallback về defaults
    const diffMs = dateTo.getTime() - dateFrom.getTime()
    expect(diffMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    expect(diffMs).toBeLessThan(8 * 24 * 60 * 60 * 1000)
  })
})
