"use client"

import { useState } from "react"
import Link from "next/link"
import { Input } from "@/components/ui/input"
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { DotTag } from "@/components/app-shell/dot-tag"
import { StatusTag } from "@/components/ui/status-tag"
import { AiLogo } from "@/app/(dashboard)/dashboard/_components/ai-logo"
import { AI_ACTION_STATUS_TONE } from "./ai-action-card"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useApproveAiAction, useRejectAiAction } from "@/hooks/ai-actions/use-ai-actions"
import {
  AI_ACTION_STATUS_LABEL,
  aiActionErrorMessage,
  aiActionResultLink,
  confirmMatches,
  type AiAction,
} from "@/lib/ai-actions"
import { formatDateTimeVn } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * Chi tiết + Duyệt/Từ chối. Dialog = bảng trượt đáy trên điện thoại, nút chính DƯỚI CÙNG và là nút đặc DUY NHẤT.
 * Duyệt = BE chạy thao tác THẬT bằng quyền của chính bạn lúc này; lỗi (mất quyền, đã xử lý, hết hạn…) hiện NGUYÊN VĂN lý do.
 * Mọi nội dung do AI soạn hiển thị dạng text (`whitespace-pre-wrap`), không render HTML.
 */
export function AiActionDialog({ action, onClose }: { action: AiAction; onClose: () => void }) {
  const approve = useApproveAiAction()
  const reject = useRejectAiAction()
  const pending = action.status === "pending"
  const busy = approve.isPending || reject.isPending
  const error = approve.isError
    ? aiActionErrorMessage(approve.error, "Không duyệt được đề xuất")
    : reject.isError
      ? aiActionErrorMessage(reject.error, "Không từ chối được đề xuất")
      : null
  const link = aiActionResultLink(action)
  const [typed, setTyped] = useState("")
  const need = pending ? (action.impact?.confirm_label ?? null) : null
  const confirmed = !need || confirmMatches(typed, need)

  function onApprove() {
    approve.mutate({ id: action.id, confirmText: need ? typed : undefined }, { onSuccess: () => { toast.success("Đã duyệt — thao tác đã được thực hiện"); onClose() } })
  }
  function onReject() {
    reject.mutate(action.id, { onSuccess: () => { toast.success("Đã từ chối đề xuất"); onClose() } })
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <AiLogo name={action.client_name} size={26} />
            {action.tool_label}
            {action.status === "pending" ? <StatusTag kind="pending" /> : <DotTag tone={AI_ACTION_STATUS_TONE[action.status]}>{AI_ACTION_STATUS_LABEL[action.status]}</DotTag>}
          </DialogTitle>
          <DialogDescription>
            Do <strong className="break-words">{action.client_name ?? "ứng dụng AI"}</strong> {action.status === "executed" ? "thực hiện" : "đề xuất"} lúc {formatDateTimeVn(action.created_at)}
            {pending ? <>, hết hạn {formatDateTimeVn(action.expires_at)}.</> : "."}
          </DialogDescription>
        </DialogHeader>

        {pending && (
          <p className="flex items-start gap-2 rounded-lg bg-[var(--color-app-tag-amber-bg)] p-3 text-sm text-[var(--color-app-tag-amber-ink)]" role="note">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Nội dung do AI soạn — hãy đọc kỹ. Chưa có gì được thực hiện cho tới khi bạn bấm Duyệt; khi duyệt, hệ thống chạy theo đúng quyền hiện tại của bạn.
          </p>
        )}

        <p className="break-words text-sm font-medium">{action.summary}</p>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
          {action.details.map((d, i) => (
            <div key={`${d.label}-${i}`} className="contents">
              <dt className="text-muted-foreground">{d.label}</dt>
              <dd className="whitespace-pre-wrap break-words">{d.value}</dd>
            </div>
          ))}
        </dl>

        {action.impact && action.impact.lines.length > 0 && (
          <div role="alert" data-testid="impact-box"
            className={cn("space-y-2 rounded-lg border p-3 text-sm", action.impact.affected_records > 0 ? "border-[var(--color-app-tag-red-ink)]/30 bg-[var(--color-app-tag-red-bg)] text-[var(--color-app-tag-red-ink)]" : "border-[var(--color-app-tag-amber-ink)]/30 bg-[var(--color-app-tag-amber-bg)] text-[var(--color-app-tag-amber-ink)]")}>
            <p className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              {action.impact.affected_records > 0
                ? `CẢNH BÁO: ${action.impact.affected_records} bản ghi đang có bị ảnh hưởng`
                : "Ảnh hưởng của thay đổi"}
            </p>
            <ul className="list-disc space-y-1 pl-5">
              {action.impact.lines.map((l) => <li key={l} className="break-words">{l}</li>)}
            </ul>
            {action.impact.affected_records > 0 && <p className="text-sm">Trinity đã lưu phiên bản cấu trúc trước khi đổi — có thể nhờ AI quay lui (restore_structure_version).</p>}
            {need && (
              <label className="block space-y-1">
                <span className="text-sm font-medium">Gõ tên bảng <strong>{need}</strong> để xác nhận</span>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={`Gõ tên bảng ${need} để xác nhận`} autoComplete="off" />
              </label>
            )}
          </div>
        )}

        {action.status === "failed" && action.error && (
          <p className="flex items-start gap-2 text-sm text-[var(--color-app-tag-red-ink)]" role="alert">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span className="break-words">{action.error}</span>
          </p>
        )}
        {error && action.status !== "failed" && (
          <p className="flex items-start gap-2 text-sm text-[var(--color-app-tag-red-ink)]" role="alert">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span className="break-words">{error}</span>
          </p>
        )}

        <DialogFooter>
          {pending ? (
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={onReject}>
                {reject.isPending && <Loader2 className="animate-spin" aria-hidden />} Từ chối
              </Button>
              <Button type="button" disabled={busy || !confirmed} onClick={onApprove} variant={need ? "destructive" : "default"}>
                {approve.isPending && <Loader2 className="animate-spin" aria-hidden />} Duyệt và thực hiện
              </Button>
            </>
          ) : (
            <>
              {link && <Link href={link.href} className={cn(buttonVariants({ variant: "outline" }), "max-sm:min-h-11 max-sm:w-full")}>{link.label}</Link>}
              <Button type="button" variant="ghost" onClick={onClose}>Đóng</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
