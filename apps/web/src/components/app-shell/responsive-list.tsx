import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Chuyển bảng cuộn ngang → danh sách dạng thẻ trên điện thoại.
 *
 * Desktop (≥640px, breakpoint `sm` của Tailwind) giữ NGUYÊN bảng gốc —
 * `table` truyền vào KHÔNG bị đổi gì. Dưới 640px, bảng bị ẩn hẳn (không còn
 * cuộn ngang để xem) và thay bằng `cards` (danh sách thẻ dọc, mỗi thẻ 1
 * dòng dữ liệu, dựng tự do theo từng màn — xem `ShellListCard`).
 */
export function ShellResponsiveList({
  table,
  cards,
  className,
}: {
  table: ReactNode
  cards: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <div className="hidden sm:block">{table}</div>
      <div className="sm:hidden">{cards}</div>
    </div>
  )
}
