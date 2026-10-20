import { cn } from "@/lib/utils"
import { Skeleton } from "./skeleton"

/**
 * Trạng thái "đang tải" dùng chung — giữ đúng khung nội dung sắp hiện thay cho chữ "Đang tải…"/vòng quay,
 * để bố cục không nhảy khi dữ liệu về. Phỏng theo `skeleton` của Arc Library (MIT).
 * - `lines`: vài dòng chữ (dòng đầu đậm 48%, dòng cuối 72%), tuỳ chọn avatar.
 * - `cards`: các thẻ xếp dọc (cột kanban, danh sách thẻ).
 */
export function LoadingBlock({
  variant = "lines",
  count = 3,
  avatar = false,
  label = "Đang tải…",
  className,
}: {
  variant?: "lines" | "cards"
  count?: number
  avatar?: boolean
  label?: string
  className?: string
}) {
  const n = Math.min(Math.max(Math.floor(count), 1), 8)
  return (
    <div role="status" aria-busy="true" className={cn("w-full", className)}>
      <span className="sr-only">{label}</span>
      {variant === "cards" ? (
        <div aria-hidden className="flex flex-col gap-2">
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
              <Skeleton index={i * 2} className="h-3.5 w-3/4" />
              <Skeleton index={i * 2 + 1} className="mt-2.5 h-3 w-2/5" />
            </div>
          ))}
        </div>
      ) : (
        <div aria-hidden className="flex items-start gap-4">
          {avatar && <Skeleton index={0} className="size-9 shrink-0 rounded-full" />}
          <div className="grid flex-1 gap-3 pt-1">
            {Array.from({ length: n }, (_, i) => (
              <Skeleton
                key={i}
                index={i + (avatar ? 1 : 0)}
                className={cn("h-3 w-full", i === 0 && "h-4 w-[48%]", i === n - 1 && i !== 0 && "w-[72%]")}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
