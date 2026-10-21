import type { ReactNode } from "react"
import Link from "next/link"
import { PlugZap, RotateCw } from "lucide-react"
import type { ShellBadgeTone } from "@/components/app-shell/badge"
import { DotTag } from "@/components/app-shell/dot-tag"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { cn } from "@/lib/utils"

/* =============================================================================
 * Cùng tình huống → cùng một mẫu (xem docs/TRANG-THAI.md).
 * Trước đây "Chờ duyệt" có ~9 kiểu hiển thị, "cần kết nối lại" có 4 cách nói và 7 màu.
 * Mọi màn dùng `StatusTag` cho các trạng thái lặp lại dưới đây: cùng chữ, cùng màu, cùng chấm.
 * ========================================================================== */

export type StatusKind = "pending" | "reauth" | "running" | "off" | "error"

const KIND: Record<StatusKind, { tone: ShellBadgeTone; label: string }> = {
  /** Đang chờ một người duyệt (đề xuất AI, đơn nghỉ, phiếu lương, tiện ích…). */
  pending: { tone: "amber", label: "Chờ duyệt" },
  /** Kênh/tích hợp mất quyền truy cập (token hết hạn, bị thu hồi) — người dùng phải kết nối lại. */
  reauth: { tone: "amber", label: "Cần kết nối lại" },
  running: { tone: "green", label: "Đang chạy" },
  off: { tone: "slate", label: "Đã tắt" },
  error: { tone: "red", label: "Lỗi" },
}

/** Chữ chuẩn của từng trạng thái — dùng cho toast, aria-label, tiêu đề, để câu chữ khớp với nhãn. */
export const STATUS_LABEL: Record<StatusKind, string> = Object.fromEntries(
  Object.entries(KIND).map(([k, v]) => [k, v.label]),
) as Record<StatusKind, string>

export function StatusTag({
  kind,
  children,
  size = "md",
  title,
  className,
}: {
  kind: StatusKind
  /** Chữ cụ thể hơn khi cần ("Chờ Kế toán duyệt"); mặc định là chữ chuẩn. */
  children?: ReactNode
  /** `sm` cho dòng dày (dòng kết nối, ô bảng). */
  size?: "sm" | "md"
  title?: string
  className?: string
}) {
  const k = KIND[kind]
  return (
    <DotTag tone={k.tone} title={title} className={cn(size === "sm" && "h-5 px-1.5 py-0 text-xs", className)}>
      <span data-status={kind}>{children ?? k.label}</span>
    </DotTag>
  )
}

/**
 * Khoảnh khắc kênh mất kết nối: nói rõ kênh nào, vì sao, và một nút "Kết nối lại".
 * `href` khi kết nối lại ở màn khác; `onReconnect` khi bắt đầu luồng OAuth ngay tại chỗ.
 */
export function ReconnectNotice({
  channel,
  reason,
  href,
  onReconnect,
  reconnecting = false,
  className,
}: {
  /** Tên kênh người dùng nhận ra được: "Fanpage AiiLab", "Zalo OA", "kênh YouTube". */
  channel: string
  /** Vì sao (vd "Token hết hạn từ 12/10/2026"); mặc định nói chung về quyền truy cập. */
  reason?: string
  href?: string
  onReconnect?: () => void
  reconnecting?: boolean
  className?: string
}) {
  const label = reconnecting ? "Đang mở…" : "Kết nối lại"
  const icon = <RotateCw className={cn("size-4", reconnecting && "animate-spin motion-reduce:animate-none")} aria-hidden />
  return (
    <div
      role="status"
      data-testid="reconnect-notice"
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-app-tag-amber-ink)]/25 bg-[var(--color-app-tag-amber-bg)] px-3 py-2.5 text-[14px]",
        className,
      )}
    >
      <PlugZap className="size-4 shrink-0 text-[var(--color-app-tag-amber-ink)]" aria-hidden />
      <p className="min-w-0 flex-1 text-[var(--foreground)]">
        <span className="font-medium">{channel} {STATUS_LABEL.reauth.toLowerCase()}.</span>{" "}
        <span className="text-[var(--color-app-ink-2)]">
          {reason ?? "Trinity không còn quyền truy cập kênh này nên tạm dừng nhận tin và đăng bài."}
        </span>
      </p>
      {onReconnect ? (
        <Button type="button" variant="outline" size="sm" onClick={onReconnect} disabled={reconnecting} className="h-8 gap-1.5 max-sm:min-h-11">
          {icon}{label}
        </Button>
      ) : href ? (
        <Link href={href} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 gap-1.5 max-sm:min-h-11")}>
          {icon}{label}
        </Link>
      ) : null}
    </div>
  )
}
