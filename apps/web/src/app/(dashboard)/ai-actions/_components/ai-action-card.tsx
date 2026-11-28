"use client"

import type { ShellBadgeTone } from "@/components/app-shell/badge"
import { AI_ACTION_STATUS_LABEL, type AiAction, type AiActionStatus } from "@/lib/ai-actions"
import { formatDateTimeVn, formatTimeVn } from "@/lib/format"
import { AiLogo } from "@/app/(dashboard)/dashboard/_components/ai-logo"
import { cn } from "@/lib/utils"
import { ChevronRight } from "lucide-react"

/** Màu nhãn trạng thái (cặp token AA): chờ duyệt = vàng, xong = xanh lá, lỗi = đỏ, kết thúc khác = xám. */
export const AI_ACTION_STATUS_TONE: Record<AiActionStatus, ShellBadgeTone> = {
  pending: "amber",
  executing: "blue",
  approved: "green",
  executed: "green",
  rejected: "slate",
  expired: "slate",
  failed: "red",
}

const PILL: Record<AiActionStatus, string> = {
  pending: "bg-ax-warn-soft text-ax-warn",
  executing: "bg-ax-primary-soft text-ax-primary-ink",
  approved: "bg-ax-success-soft text-ax-success",
  executed: "bg-ax-success-soft text-ax-success",
  rejected: "bg-ax-sunken text-ax-ink-2",
  expired: "bg-ax-sunken text-ax-ink-2",
  failed: "bg-ax-danger-soft text-[var(--ax-danger-ink)]",
}

/** Nhãn trạng thái «Ánh xanh»: chấm 6px + chữ 12/600, cao 24, bo 999. */
export function AiStatusPill({ status }: { status: AiActionStatus }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold", PILL[status])}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {AI_ACTION_STATUS_LABEL[status]}
    </span>
  )
}

/** Đề xuất đổi cấu trúc đang có bản ghi bị ảnh hưởng (cần xác nhận kỹ). */
export const isRisky = (a: AiAction) => a.status === "pending" && (a.impact?.affected_records ?? 0) > 0

/**
 * Dòng danh sách DESKTOP (cột trái, master–detail): logo trợ lý · tóm tắt · «ứng dụng · thao tác · giờ» · trạng thái.
 * Cả dòng là một nút chọn (`aria-current` khi đang xem). `summary`/`client_name`/`error` là văn bản do AI soạn ⇒ chỉ hiển thị dạng text.
 */
export function AiActionRow({ action, current, onOpen }: { action: AiAction; current: boolean; onOpen: () => void }) {
  return (
    <li data-testid="ai-action-card" className="border-t border-ax-divider first:border-t-0">
      <button
        type="button"
        onClick={onOpen}
        aria-current={current ? "true" : undefined}
        className={cn(
          "flex min-h-[72px] w-full items-start gap-3 px-[18px] py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
          current ? "bg-ax-primary-soft" : "hover:bg-ax-hover",
        )}
      >
        <AiLogo name={action.client_name} size={32} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn("break-words text-[15px] font-semibold leading-snug", current ? "text-ax-primary-ink" : "text-ax-ink")}>{action.summary}</span>
          <span className="break-words text-[13px] tabular-nums text-ax-ink-2">
            {action.client_name ?? "Ứng dụng AI"} · {action.tool_label} · <time dateTime={action.created_at} title={formatDateTimeVn(action.created_at)}>{formatTimeVn(action.created_at)}</time>
          </span>
          {action.status === "failed" && action.error && <span className="break-words text-[13px] text-[var(--ax-danger-ink)]">{action.error}</span>}
        </span>
        <AiStatusPill status={action.status} />
      </button>
    </li>
  )
}

/**
 * Thẻ danh sách ĐIỆN THOẠI: «ứng dụng · giờ» + trạng thái, tóm tắt 16/600, cảnh báo ảnh hưởng, «Xem và duyệt ›».
 * Cả thẻ là một nút (vùng chạm ≥ 44px).
 */
export function AiActionCard({ action, onOpen }: { action: AiAction; onOpen: () => void }) {
  const pending = action.status === "pending"
  return (
    <li data-testid="ai-action-card">
      <button
        type="button"
        onClick={onOpen}
        className="ax-card flex min-h-11 w-full flex-col gap-2 p-3.5 text-left transition-colors active:bg-ax-hover focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-[13px] tabular-nums text-ax-ink-3">
            <AiLogo name={action.client_name} size={22} />
            <span className="truncate">{action.client_name ?? "Ứng dụng AI"} · <time dateTime={action.created_at} title={formatDateTimeVn(action.created_at)}>{formatTimeVn(action.created_at)}</time></span>
          </span>
          <AiStatusPill status={action.status} />
        </span>
        <span className="break-words text-base font-semibold leading-snug text-ax-ink">{action.summary}</span>
        {isRisky(action) && <span className="text-[13px] font-semibold text-[var(--ax-danger-ink)]">Có bản ghi bị ảnh hưởng, cần xác nhận kỹ</span>}
        {action.status === "failed" && action.error && <span className="break-words text-[13px] text-[var(--ax-danger-ink)]">{action.error}</span>}
        <span className="flex items-center gap-1 text-[15px] font-semibold text-ax-primary-ink">
          {pending ? "Xem và duyệt" : "Xem chi tiết"}
          <ChevronRight className="size-4" strokeWidth={2.4} aria-hidden />
        </span>
      </button>
    </li>
  )
}
