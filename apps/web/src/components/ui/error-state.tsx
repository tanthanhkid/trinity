import { AlertTriangle, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { buttonVariants } from "@/components/ui/button-variants"
import { ERROR_MESSAGES, describeError, errorKind } from "@/lib/error-messages"
import { cn } from "@/lib/utils"

/**
 * Khung "không tải được" dùng chung — nói rõ chuyện gì + cách sửa + nút "Thử lại".
 * Dùng thay cho việc coi lỗi như "chưa có dữ liệu" (người dùng tưởng tài khoản trống) hoặc để khung xương quay mãi.
 * `error` là lỗi từ react-query/axios; câu giải thích lấy từ bảng thông điệp chung `lib/error-messages.ts`.
 * Hết phiên ⇒ nút "Đăng nhập lại"; thiếu quyền ⇒ không có nút Thử lại (thử lại cũng không được) mà chỉ cách xin quyền.
 */
export function ErrorState({
  title = "Không tải được dữ liệu",
  error,
  message,
  onRetry,
  retrying = false,
  compact = false,
  className,
}: {
  title?: string
  /** Lỗi gốc; bỏ qua khi đã truyền `message`. */
  error?: unknown
  /** Câu giải thích tự viết; mặc định lấy từ `error`. */
  message?: string
  /** Có thì hiện nút "Thử lại" (thường là `refetch` của react-query). */
  onRetry?: () => void
  retrying?: boolean
  /** Bản gọn một dòng cho ô nhỏ (thẻ, cột kanban). */
  compact?: boolean
  className?: string
}) {
  const kind = error === undefined ? null : errorKind(error)
  const text = message ?? describeError(error)
  const canRetry = kind === null || ERROR_MESSAGES[kind].retry
  const retry = kind === "session" ? (
    <Link href="/login" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 rounded-lg max-sm:min-h-11")}>
      Đăng nhập lại
    </Link>
  ) : onRetry && canRetry ? (
    <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={retrying} className="h-8 rounded-lg max-sm:min-h-11">
      <RotateCw className={cn("mr-1.5 size-4", retrying && "animate-spin motion-reduce:animate-none")} aria-hidden />
      {retrying ? "Đang thử lại…" : "Thử lại"}
    </Button>
  ) : null

  if (compact) {
    return (
      <div role="alert" className={cn("flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground", className)}>
        <AlertTriangle className="size-4 shrink-0 text-[var(--color-app-tag-amber-ink)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-foreground">{title}.</span> {text}
        </span>
        {retry}
      </div>
    )
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-center text-muted-foreground",
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-[var(--color-app-tag-amber-ink)]">
        <AlertTriangle className="size-6" aria-hidden />
      </span>
      <div className="flex max-w-md flex-col gap-1 text-balance">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-[13px] leading-5">{text}</p>
      </div>
      {retry && <div className="mt-1">{retry}</div>}
    </div>
  )
}
