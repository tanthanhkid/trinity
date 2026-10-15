"use client"

import { DateRangePicker } from "@/components/ui/date-range-picker"
import type { DateRange } from "@/lib/date-range-presets"
import { todayVn } from "@/lib/format"

export type { DateRange }

interface Props {
  value: DateRange
  onChange: (range: DateRange) => void
}

/**
 * Bộ lọc khoảng ngày của Báo cáo: MỘT nút mở lịch chọn Từ–Đến
 * kèm "Khoảng nhanh" (Hôm nay, Tuần này, 7/30 ngày, Tháng này/trước, Năm nay).
 * Hiển thị `dd/mm/yyyy`, phát ISO `YYYY-MM-DD`; không cho chọn quá hôm nay (VN).
 * Thay cho cặp ô gõ + dropdown "Khoảng nhanh" cũ (cùng contract `DateRange`).
 */
export function DateRangeFilter({ value, onChange }: Props) {
  // Tính mỗi render để qua mốc 00:00 VN tự cập nhật (không memo).
  return (
    <DateRangePicker
      value={value}
      max={todayVn()}
      ariaLabel="Khoảng ngày báo cáo"
      onChange={(range) => {
        if (range.date_from !== value.date_from || range.date_to !== value.date_to) onChange(range)
      }}
    />
  )
}
