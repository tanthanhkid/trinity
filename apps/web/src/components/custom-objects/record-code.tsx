import { cn } from "@/lib/utils"

/** Mã chung của bản ghi (SP001, KH012…) — dùng để gắn thẻ @ ở màn khác. Không có mã ⇒ không hiện gì. */
export function RecordCode({ code, className }: { code: string | null | undefined; className?: string }) {
  if (!code) return null
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-muted-foreground", className)} data-testid="record-code">
      {code}
    </span>
  )
}
