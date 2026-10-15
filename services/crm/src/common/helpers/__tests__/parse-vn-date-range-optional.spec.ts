import { BadRequestException } from '@nestjs/common'
import {
  buildVnCreatedAtFilter,
  parseVnDateRangeOptional,
} from '../parse-vn-date-range.helper'

/**
 * Khoá 2 bất biến của bộ lọc khoảng ngày:
 *  1. KHÔNG chọn ngày → KHÔNG sinh mệnh đề nào (không âm thầm cắt bản ghi cũ).
 *  2. Ngày người dùng chọn là ngày GIỜ VN, không phải UTC.
 */
describe('parseVnDateRangeOptional / buildVnCreatedAtFilter', () => {
  it('KHÔNG chọn ngày nào → undefined, KHÔNG ép khoảng mặc định', () => {
    expect(parseVnDateRangeOptional(undefined, undefined)).toEqual({
      dateFrom: undefined,
      dateTo: undefined,
    })
    // Quan trọng nhất: filter phải là `undefined` để caller KHÔNG gắn `created_at`
    // vào where — gắn vào là cắt mất bản ghi cũ mà không ai thấy.
    expect(buildVnCreatedAtFilter(undefined, undefined)).toBeUndefined()
  })

  it('quy đổi đúng GIỜ VN: đầu ngày = 17:00Z hôm trước, cuối ngày = 16:59:59.999Z', () => {
    const { dateFrom, dateTo } = parseVnDateRangeOptional('2026-08-01', '2026-08-18')
    // 2026-08-01T00:00+07 = 2026-07-31T17:00Z — nếu parse naive sẽ ra 08-01T00:00Z
    // và mất trọn 7 giờ đầu ngày (đơn tạo 02:00 sáng VN bị loại oan).
    expect(dateFrom?.toISOString()).toBe('2026-07-31T17:00:00.000Z')
    expect(dateTo?.toISOString()).toBe('2026-08-18T16:59:59.999Z')
  })

  it('chỉ chọn 1 biên → chỉ sinh đúng 1 mệnh đề tương ứng', () => {
    expect(buildVnCreatedAtFilter('2026-08-01', undefined)).toEqual({
      gte: new Date('2026-07-31T17:00:00.000Z'),
    })
    expect(buildVnCreatedAtFilter(undefined, '2026-08-18')).toEqual({
      lte: new Date('2026-08-18T16:59:59.999Z'),
    })
  })

  it('cùng một ngày cho cả 2 biên → khoảng phủ trọn ngày đó theo giờ VN', () => {
    const f = buildVnCreatedAtFilter('2026-08-18', '2026-08-18')
    expect(f?.gte?.toISOString()).toBe('2026-08-17T17:00:00.000Z')
    expect(f?.lte?.toISOString()).toBe('2026-08-18T16:59:59.999Z')
  })

  it('định dạng sai → 400 (KHÔNG im lặng bỏ qua filter)', () => {
    // Im lặng bỏ qua sẽ trả về TOÀN BỘ dữ liệu trong khi người dùng tin là đã lọc.
    expect(() => parseVnDateRangeOptional('18/08/2026', undefined)).toThrow(
      BadRequestException,
    )
    expect(() => parseVnDateRangeOptional(undefined, '2026-8-1')).toThrow(
      BadRequestException,
    )
  })

  it('khoảng đảo ngược (từ > đến) → 400', () => {
    expect(() => parseVnDateRangeOptional('2026-08-18', '2026-08-01')).toThrow(
      BadRequestException,
    )
  })
})
