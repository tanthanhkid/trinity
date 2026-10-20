"use client"

/**
 * Nút sắp xếp ở đầu cột bảng — phỏng theo `sortable-data-table` của Arc Library (MIT, xem lib/motion-tokens.ts):
 * cột sắp được luôn có mũi tên mờ để biết bấm được; đang sắp thì mũi tên đậm và XOAY giữa tăng/giảm
 * thay vì đổi icon đột ngột.
 */
import { ArrowUp, ArrowUpDown } from "lucide-react"
import { motion } from "motion/react"
import { motionTokens } from "@/lib/motion-tokens"
import { cn } from "@/lib/utils"

/** Mũi tên sắp xếp: mờ khi chưa sắp theo cột này, đậm + xoay giữa tăng/giảm khi đang sắp. */
export function SortArrow({ dir, className }: { dir: "asc" | "desc" | null; className?: string }) {
  return (
    <span className={cn("inline-grid size-3.5 place-items-center", className)} aria-hidden>
      {dir ? (
        <motion.span
          className="inline-grid"
          initial={false}
          animate={{ rotate: dir === "asc" ? 0 : 180 }}
          transition={motionTokens.spring.snappy}
        >
          <ArrowUp className="size-3.5" />
        </motion.span>
      ) : (
        <ArrowUpDown className="size-3.5 opacity-30 transition-opacity group-hover:opacity-70" />
      )}
    </span>
  )
}

export function SortHeader({
  label,
  dir,
  onToggle,
  className,
}: {
  label: React.ReactNode
  /** Cột này đang sắp theo chiều nào; `null` là không sắp theo cột này. */
  dir: "asc" | "desc" | null
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "group relative inline-flex items-center gap-1 font-semibold after:absolute after:-inset-3 after:content-['']",
        className,
      )}
    >
      {label}
      <SortArrow dir={dir} />
    </button>
  )
}
