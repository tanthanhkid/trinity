"use client"

import { useState } from "react"
import { AlertTriangle, ChevronLeft, Loader2, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { Button, buttonVariants } from "@/components/ui/button"
import { HeroCard } from "@/components/ui/hero-card"
import { Input } from "@/components/ui/input"
import { AiLogo } from "@/app/(dashboard)/dashboard/_components/ai-logo"
import { useApproveAiAction, useRejectAiAction } from "@/hooks/ai-actions/use-ai-actions"
import { aiActionErrorMessage, aiActionResultLink, confirmMatches, type AiAction } from "@/lib/ai-actions"
import { formatDateTimeVn } from "@/lib/format"
import { cn } from "@/lib/utils"
import { AiStatusPill } from "./ai-action-card"

/** Nút duyệt khi đổi cấu trúc nguy hiểm: gradient đỏ 3 điểm như thiết kế (mobile2), nền xám khi chưa xác nhận. */
const DANGER_GRAD = "linear-gradient(180deg,#CC524C 0%,#C2413B 52%,#B23A34 100%)"

/**
 * Trạng thái + hành động Duyệt/Từ chối của MỘT đề xuất, dùng chung cho bố cục desktop và điện thoại.
 * Duyệt = BE chạy thao tác THẬT bằng quyền của chính bạn lúc này; lỗi (mất quyền, đã xử lý, hết hạn…) hiện NGUYÊN VĂN lý do.
 */
function useDecision(action: AiAction, onDone?: () => void) {
  const approve = useApproveAiAction()
  const reject = useRejectAiAction()
  const pending = action.status === "pending"
  const busy = approve.isPending || reject.isPending
  const error = approve.isError
    ? aiActionErrorMessage(approve.error, "Không duyệt được đề xuất")
    : reject.isError
      ? aiActionErrorMessage(reject.error, "Không từ chối được đề xuất")
      : null
  const [typed, setTyped] = useState("")
  const need = pending ? (action.impact?.confirm_label ?? null) : null
  const confirmed = !need || confirmMatches(typed, need)
  return {
    pending, busy, error, typed, setTyped, need, confirmed,
    approving: approve.isPending, rejecting: reject.isPending,
    onApprove: () => approve.mutate({ id: action.id, confirmText: need ? typed : undefined }, { onSuccess: () => { toast.success("Đã duyệt — thao tác đã được thực hiện"); onDone?.() } }),
    onReject: () => reject.mutate(action.id, { onSuccess: () => { toast.success("Đã từ chối đề xuất"); onDone?.() } }),
  }
}
type Decision = ReturnType<typeof useDecision>

function ImpactBox({ action, d, mobile }: { action: AiAction; d: Decision; mobile?: boolean }) {
  const impact = action.impact
  if (!d.pending || !impact || impact.lines.length === 0) return null
  const hit = impact.affected_records > 0
  return (
    <div
      role="alert"
      data-testid="impact-box"
      className={cn(
        "space-y-2.5 rounded-ax-field border p-4 text-sm",
        mobile && "text-[15px]",
        hit ? "border-ax-danger-border bg-ax-danger-soft text-[#8A2D28]" : "border-ax-warn/30 bg-ax-warn-soft text-ax-warn",
      )}
    >
      <p className={cn("flex items-center gap-2 text-[15px] font-bold", hit ? "text-[var(--ax-danger-ink)]" : "text-ax-warn")}>
        <AlertTriangle className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
        {hit ? `CẢNH BÁO: ${impact.affected_records} bản ghi đang có bị ảnh hưởng` : "Ảnh hưởng của thay đổi"}
      </p>
      <ul className="list-disc space-y-1 pl-5 leading-relaxed">
        {impact.lines.map((l) => <li key={l} className="break-words">{l}</li>)}
      </ul>
      {hit && <p className="text-[13px] leading-snug">Trinity đã lưu phiên bản cấu trúc trước khi đổi — có thể nhờ AI quay lui (restore_structure_version).</p>}
      {d.need && (
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-ax-ink">Gõ tên bảng <strong>{d.need}</strong> để xác nhận</span>
          <Input variant="ax" value={d.typed} onChange={(e) => d.setTyped(e.target.value)} aria-label={`Gõ tên bảng ${d.need} để xác nhận`} autoComplete="off" className={cn(!mobile && "max-w-80")} />
        </label>
      )}
    </div>
  )
}

/** Khối kết quả theo trạng thái cuối: thất bại / đã thực hiện / từ chối / hết hạn + lỗi của lần bấm vừa rồi. */
function Outcome({ action, d, mobile }: { action: AiAction; d: Decision; mobile?: boolean }) {
  const link = aiActionResultLink(action)
  const base = cn("rounded-ax-field px-4 py-3.5 text-sm leading-relaxed", mobile && "text-[15px]")
  return (
    <>
      {action.status === "failed" && action.error && (
        <p role="alert" className={cn(base, "flex items-start gap-2 bg-ax-danger-soft text-[var(--ax-danger-ink)]")}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span className="break-words">{action.error}</span>
        </p>
      )}
      {d.error && action.status !== "failed" && (
        <p role="alert" className={cn(base, "flex items-start gap-2 bg-ax-danger-soft text-[var(--ax-danger-ink)]")}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span className="break-words">{d.error}</span>
        </p>
      )}
      {(action.status === "executed" || action.status === "approved") && (
        <div role="status" className={cn(base, "flex flex-wrap items-center justify-between gap-3 bg-ax-success-soft text-ax-success")}>
          <span>{action.status === "approved" ? "Đã duyệt." : "Đã thực hiện"} {action.decided_at ? `Lúc ${formatDateTimeVn(action.decided_at)}.` : ""}</span>
          {!mobile && link && <Link href={link.href} className="font-semibold text-ax-primary-ink hover:underline">{link.label}</Link>}
        </div>
      )}
      {action.status === "rejected" && <p role="status" className={cn(base, "ax-sunken text-ax-ink-2")}>Bạn đã từ chối. Hệ thống không thay đổi gì. Cần làm lại thì nhờ AI đề xuất lại.</p>}
      {action.status === "expired" && <p role="status" className={cn(base, "ax-sunken text-ax-ink-2")}>Đề xuất đã hết hạn nên không thực hiện. Cần làm lại thì nhờ AI đề xuất lại.</p>}
    </>
  )
}

function Buttons({ d, mobile }: { d: Decision; mobile: boolean }) {
  const danger = !!d.need
  const approve = (
    <Button
      type="button"
      variant="ax-primary"
      size="ax-lg"
      disabled={d.busy || !d.confirmed}
      onClick={d.onApprove}
      style={danger && d.confirmed ? { backgroundImage: DANGER_GRAD } : undefined}
      className={cn(mobile && "h-[52px] text-[17px] font-bold")}
    >
      {d.approving && <Loader2 className="animate-spin" aria-hidden />} Duyệt và thực hiện
    </Button>
  )
  const rejectBtn = (
    <Button type="button" variant={mobile ? "ax-ghost" : "ax-secondary"} size="ax-lg" disabled={d.busy} onClick={d.onReject}>
      {d.rejecting && <Loader2 className="animate-spin" aria-hidden />} Từ chối
    </Button>
  )
  return mobile ? <>{approve}{rejectBtn}</> : <>{rejectBtn}{approve}</>
}

const SAID = (a: AiAction) => (a.status === "executed" ? "thực hiện" : "đề xuất")

/**
 * Chi tiết đề xuất — DESKTOP (cột phải): đầu là khối nhấn xanh (ai · thao tác · giờ + tóm tắt), thân là «Hệ thống sẽ làm»
 * (khối lõm), cảnh báo ảnh hưởng, kết quả; chân có Từ chối + Duyệt và thực hiện (nút chính cuối).
 * Mọi nội dung do AI soạn hiển thị dạng text (`whitespace-pre-wrap`), không render HTML.
 */
export function AiActionDetailPanel({ action }: { action: AiAction }) {
  const d = useDecision(action)
  return (
    <section aria-label="Chi tiết đề xuất" data-testid="ai-detail" className="ax-card flex min-w-0 flex-col overflow-hidden">
      <HeroCard className="-m-px rounded-b-none rounded-t-[11px] px-7 pb-[22px] pt-6 max-sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-[13px] tabular-nums text-[var(--ax-on-hero-ink-2)]">
          <AiLogo name={action.client_name} size={22} />
          <span>{action.client_name ?? "Ứng dụng AI"} {SAID(action)} · {action.tool_label} · {formatDateTimeVn(action.created_at)}</span>
          <AiStatusPill status={action.status} />
        </div>
        <h2 className="ax-text-title mt-1.5 break-words !text-white">{action.summary}</h2>
      </HeroCard>

      <div className="flex flex-col gap-[18px] px-7 py-5">
        {d.pending && (
          <p className="flex items-start gap-2 text-sm leading-relaxed text-ax-ink-2" role="note">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-ax-warn" aria-hidden />
            <span>Chưa có gì được thực hiện. Nội dung do AI soạn, hãy đọc kỹ. Đề xuất hết hạn lúc <strong className="tabular-nums">{formatDateTimeVn(action.expires_at)}</strong>.</span>
          </p>
        )}
        <div>
          <h3 className="ax-text-group mb-2">Hệ thống sẽ làm</h3>
          <dl className="ax-sunken divide-y divide-ax-divider overflow-hidden rounded-ax-field border border-ax-line text-sm leading-relaxed">
            {action.details.map((x, i) => (
              <div key={`${x.label}-${i}`} className="flex gap-4 px-4 py-3">
                <dt className="w-[150px] shrink-0 text-ax-ink-2">{x.label}</dt>
                <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words tabular-nums">{x.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <ImpactBox action={action} d={d} />
        <Outcome action={action} d={d} />
      </div>

      {d.pending ? (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-ax-divider px-7 pb-5 pt-4">
          <span className="max-w-[300px] text-[13px] leading-snug text-ax-ink-3">Duyệt là chạy thật, bằng quyền hiện tại của bạn.</span>
          <div className="flex gap-2"><Buttons d={d} mobile={false} /></div>
        </footer>
      ) : null}
    </section>
  )
}

/**
 * Chi tiết đề xuất — ĐIỆN THOẠI (toàn màn, mobile2): thanh «‹ Hoạt động AI», tiêu đề, khối nhấn «Hệ thống sẽ làm»
 * (nhãn 13 / giá trị 17/600), cảnh báo ảnh hưởng, thanh đáy dính: Duyệt và thực hiện (nút chính DUY NHẤT) rồi Từ chối.
 */
export function AiActionDetailScreen({ action, onBack }: { action: AiAction; onBack: () => void }) {
  const d = useDecision(action, onBack)
  const link = aiActionResultLink(action)
  return (
    <div role="dialog" aria-modal="true" aria-label={action.tool_label} data-testid="ai-detail" className="fixed inset-0 z-50 flex flex-col bg-[var(--ax-bg-mobile)] ax-page">
      <div className="flex items-center border-b border-ax-line ax-grad-bar px-2 pb-1 pt-2">
        <button type="button" onClick={onBack} disabled={d.busy} aria-label="Quay lại Hoạt động AI" className="flex h-11 items-center pl-1 pr-2.5 text-base text-ax-primary-ink focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]">
          <ChevronLeft className="size-5" strokeWidth={1.75} aria-hidden /> Hoạt động AI
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-4 pb-3 pt-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-[13px] tabular-nums text-ax-ink-2">
            <AiLogo name={action.client_name} size={22} />
            <span>{action.client_name ?? "Ứng dụng AI"} {SAID(action)} · {action.tool_label} · {formatDateTimeVn(action.created_at)}</span>
            <AiStatusPill status={action.status} />
          </div>
          <h1 className="mt-1 break-words text-xl font-[650] leading-snug tracking-[-0.02em] text-ax-ink">{action.summary}</h1>
        </div>

        <HeroCard aria-label="Hệ thống sẽ làm" className="max-sm:rounded-[var(--ax-radius-hero)] max-sm:px-[18px] max-sm:pb-2 max-sm:pt-1.5">
          <h2 className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ax-on-hero-ink-2)]">Hệ thống sẽ làm</h2>
          <dl>
            {action.details.map((x, i) => (
              <div key={`${x.label}-${i}`} className={cn("flex flex-col gap-0.5 py-3", i > 0 && "border-t border-white/15")}>
                <dt className="text-[13px] text-[var(--ax-on-hero-ink-2)]">{x.label}</dt>
                <dd className="whitespace-pre-wrap break-words text-[17px] font-semibold leading-snug tracking-[-0.011em] text-white">{x.value}</dd>
              </div>
            ))}
          </dl>
        </HeroCard>

        {d.pending && (
          <p className="flex items-start gap-2 text-[13px] leading-snug text-ax-ink-3" role="note">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-ax-warn" aria-hidden />
            <span>Nội dung do AI soạn, hãy đọc kỹ. Chưa có gì được thực hiện. Đề xuất hết hạn {formatDateTimeVn(action.expires_at)}. Duyệt là chạy thật, theo đúng quyền của bạn.</span>
          </p>
        )}
        <ImpactBox action={action} d={d} mobile />
        <Outcome action={action} d={d} mobile />
        {!d.pending && link && (
          <Link href={link.href} className={cn(buttonVariants({ variant: "ax-secondary", size: "ax-lg" }), "text-base text-ax-primary-ink")}>{link.label}</Link>
        )}
      </div>

      {d.pending && (
        <div className="flex flex-col gap-2 border-t border-ax-line ax-grad-bar px-4 pb-[calc(20px+env(safe-area-inset-bottom))] pt-2.5">
          <Buttons d={d} mobile />
        </div>
      )}
    </div>
  )
}
