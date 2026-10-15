import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Dòng "trống"/"đang tải" dùng CHUNG cho mọi bảng cuộn ngang.
 *
 * Bảng rộng hơn viewport nằm trong khung `overflow-x-auto`. `<td colSpan>`
 * căn giữa theo TOÀN BỘ chiều rộng bảng — trên điện thoại, tâm đó thường nằm
 * ngoài khung nhìn (scrollLeft=0 chỉ hiện đúng phần đầu bảng), nên dòng
 * "Không có dữ liệu…" biến mất khỏi màn hình dù bảng vẫn rỗng.
 *
 * Fix: bọc nội dung trong 1 `<div>` `sticky left-0` với chiều rộng CO THEO
 * NỘI DUNG (`w-max`, KHÔNG kéo giãn theo `<td>`) — CSS sticky ghim div này
 * vào đúng mép trái của VÙNG CUỘN đang nhìn thấy, bất kể `<td>` bên trong
 * rộng bao nhiêu hay scrollLeft đang ở đâu.
 *
 * Dùng `<tr>`/`<td>` thuần (không import `TableRow`/`TableCell`) — tương
 * thích cả bảng `@/components/ui/table` (shadcn) lẫn `<table>` HTML trần,
 * không phụ thuộc style riêng của component nào.
 */
export function ShellTableEmptyRow({
  colSpan,
  children,
  className,
}: {
  colSpan: number
  children: ReactNode
  className?: string
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <div
          className={cn(
            "sticky left-0 w-max max-w-[calc(100vw-2rem)] px-4 py-8 text-center text-sm text-muted-foreground",
            className,
          )}
        >
          {children}
        </div>
      </td>
    </tr>
  )
}
