"use client"

import type { ShellBadgeTone } from "@/components/app-shell/badge"
import { DotTag } from "@/components/app-shell/dot-tag"
import { AI_ACTION_STATUS_LABEL, type AiAction, type AiActionStatus } from "@/lib/ai-actions"
import { formatDateTimeVn, formatTimeVn } from "@/lib/format"
import { AiLogo } from "@/app/(dashboard)/dashboard/_components/ai-logo"
import { SMALL_BTN } from "@/app/(dashboard)/dashboard/_components/home-box"
import { cn } from "@/lib/utils"

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

/**
 * 1 dòng trong dòng thời gian Hoạt động AI (cùng kiểu "AI đã làm gì hôm nay" ở Trang chủ):
 * giờ · logo trợ lý (ChatGPT/Claude/Gemini, client lạ ⇒ biểu tượng chung) · nội dung · trạng thái · nút mở.
 * `summary`/`client_name`/`error` là văn bản do AI soạn ⇒ chỉ hiển thị dạng text.
 */
export function AiActionCard({ action, onOpen }: { action: AiAction; onOpen: () => void }) {
  const pending = action.status === "pending"
  return (
    <li
      data-testid="ai-action-card"
      className="grid grid-cols-[44px_28px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-2 px-4 py-3 hover:bg-[var(--muted)] sm:grid-cols-[52px_28px_minmax(0,1fr)_auto]"
    >
      <time dateTime={action.created_at} title={formatDateTimeVn(action.created_at)} className="pt-1 text-sm tabular-nums text-muted-foreground">
        {formatTimeVn(action.created_at)}
      </time>
      <AiLogo name={action.client_name} />
      <div className="min-w-0">
        <p className="break-words text-sm font-medium leading-snug text-foreground">{action.summary}</p>
        <p className="mt-0.5 break-words text-sm leading-snug text-muted-foreground">
          <span>{action.client_name ?? "Ứng dụng AI"}</span> · {action.tool_label}
          {pending && <> · hết hạn {formatDateTimeVn(action.expires_at)}</>}
        </p>
        {action.status === "failed" && action.error && (
          <p className="mt-1 break-words text-sm text-[var(--color-app-tag-red-ink)]">{action.error}</p>
        )}
      </div>
      <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:col-start-auto sm:justify-end">
        <DotTag tone={AI_ACTION_STATUS_TONE[action.status]}>{AI_ACTION_STATUS_LABEL[action.status]}</DotTag>
        <button type="button" onClick={onOpen} className={cn(SMALL_BTN, pending && "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/90")}>
          {pending ? "Xem & duyệt" : "Xem chi tiết"}
        </button>
      </div>
    </li>
  )
}
