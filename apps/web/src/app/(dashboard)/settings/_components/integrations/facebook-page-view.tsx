"use client"

import { useState, useSyncExternalStore } from "react"
import { ChevronLeft, ChevronRight, Loader2, PauseCircle, ShieldAlert, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { BottomSheet, BottomSheetClose, BottomSheetContent } from "@/components/ui/bottom-sheet"
import { Button } from "@/components/ui/button"
import { HeroCard } from "@/components/ui/hero-card"
import { StickyActionBar } from "@/components/ui/sticky-action-bar"
import { showUndoToast } from "@/components/ui/undo-toast"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"
import {
  STATE_TONE,
  initials,
  pageBanner,
  pageChecks,
  pageEvents,
  pageState,
  type FbTone,
} from "./facebook-page-state"
import { TOKEN_STATUS_LABELS, useAdminGuide, useFacebookPageMutations, type FacebookPageView } from "./use-facebook"
import { apiErrorMessage, type SimpleOption } from "./webhook-types"

const TEXT: Record<FbTone | "info", string> = { ok: "text-ax-success", bad: "text-ax-danger", off: "text-ax-ink-2", warn: "text-ax-warn", info: "text-ax-ink-2" }
const SOFT: Record<FbTone, string> = { ok: "bg-ax-success-soft", bad: "bg-ax-danger-soft", off: "bg-ax-sunken", warn: "bg-ax-warn-soft" }
const DOT: Record<FbTone | "info", string> = { ok: "bg-ax-success", bad: "bg-ax-danger", off: "bg-ax-ink-3", warn: "bg-ax-warn", info: "bg-ax-ink-3" }

/** Thiết kế «Ánh xanh» tách hai bố cục: desktop từ 1024px, điện thoại dưới đó (không co giãn một bố cục). */
const subscribeWide = (cb: () => void) => {
  window.addEventListener("resize", cb)
  return () => window.removeEventListener("resize", cb)
}
export function useIsWide() {
  return useSyncExternalStore(subscribeWide, () => window.innerWidth >= 1024, () => true)
}

export interface PageDetailProps {
  page: FacebookPageView
  assignees: SimpleOption[]
  sources: SimpleOption[]
  canPickAssignee: boolean
  onReconnect: () => void
  reconnecting: boolean
}

const optLabel = (list: SimpleOption[], id: number) => list.find((o) => o.id === id)?.label ?? "Chưa chọn"

/** Gói PATCH + toast Hoàn tác: lưu NGAY rồi cho hoàn tác (đưa về giá trị cũ bằng PATCH thứ hai). */
function useSaveWithUndo(page: FacebookPageView) {
  const m = useFacebookPageMutations()
  type Body = { default_assignee_id?: number; contact_source_id?: number; is_active?: boolean }
  const save = (body: Body, message: string, prev: Body) =>
    m.update.mutate(
      { id: page.id, ...body },
      {
        onSuccess: () => {
          showUndoToast(message, {
            onUndo: () => m.update.mutate({ id: page.id, ...prev }, { onError: (e) => toast.error(apiErrorMessage(e, "Không hoàn tác được")) }),
          })
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Không lưu được")),
      },
    )
  return { m, save }
}

function Spinner() {
  return <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
}

function ToneMark({ tone, mark }: { tone: FbTone; mark: string }) {
  return (
    <span aria-hidden className={cn("mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full text-[13px] font-bold", SOFT[tone], TEXT[tone])}>
      {mark}
    </span>
  )
}

/** Khối nhấn đầu trang: trạng thái kết nối + một nút (Kiểm tra lại / Kết nối lại). Mỗi màn đúng một khối. */
function StatusHero({ page, onCheck, checking, onReconnect, reconnecting, mobile }: { page: FacebookPageView; onCheck: () => void; checking: boolean; onReconnect: () => void; reconnecting: boolean; mobile?: boolean }) {
  const state = pageState(page)
  const b = pageBanner(page)
  const needReconnect = state === "bad" || state === "disconnected"
  const Icon = state === "running" || state === "paused" ? (state === "running" ? ShieldCheck : PauseCircle) : ShieldAlert
  return (
    <HeroCard role="status" data-testid="fb-hero" className={cn(!mobile && "flex flex-wrap items-center gap-5 px-6 py-[22px]", mobile && "p-5")}>
      <div className={cn(mobile ? "flex items-center gap-3" : "contents")}>
        <div aria-hidden className={cn("flex size-[52px] shrink-0 items-center justify-center rounded-[14px] shadow-[0_8px_18px_-8px_rgba(13,32,54,.6)]", SOFT[STATE_TONE[state]], TEXT[STATE_TONE[state]], mobile && "size-10 rounded-xl")}>
          <Icon className={mobile ? "size-5" : "size-6"} />
        </div>
        {mobile && <div className="ax-text-subhead text-white">{b.title}</div>}
      </div>
      <div className={cn("min-w-0", !mobile && "flex-[1_1_360px]")}>
        {!mobile && <div className="ax-text-heading text-white">{b.title}</div>}
        <p className={cn("text-sm leading-relaxed text-[var(--ax-on-hero-ink-2)]", mobile ? "mt-2" : "mt-1 max-w-[760px]")}>{b.text}</p>
      </div>
      <div className={cn("flex gap-2", mobile && "mt-4")}>
        {needReconnect ? (
          <Button variant="ax-on-hero" size="ax-lg" onClick={onReconnect} disabled={reconnecting} className={cn(mobile && "w-full")}>
            {reconnecting && <Spinner />}
            {reconnecting ? "Đang mở Facebook" : "Kết nối lại Fanpage"}
          </Button>
        ) : (
          <Button variant="ax-on-hero-secondary" size="ax-lg" onClick={onCheck} disabled={checking} className={cn(mobile && "w-full")}>
            {checking && <Spinner />}
            {checking ? "Đang kiểm tra" : "Kiểm tra lại"}
          </Button>
        )}
      </div>
      {mobile && <p className="mt-3 text-[13px] text-[var(--ax-on-hero-ink-2)]">{page.token_checked_at ? `Kiểm lần cuối ${formatDateTime(page.token_checked_at)}` : "Chưa kiểm tra"}</p>}
    </HeroCard>
  )
}

function useCheck(page: FacebookPageView) {
  const m = useFacebookPageMutations()
  return {
    pending: m.check.isPending,
    run: () => m.check.mutate(page.id, { onSuccess: (r) => toast.success(TOKEN_STATUS_LABELS[r.token_status]), onError: (e) => toast.error(apiErrorMessage(e, "Không kiểm tra được")) }),
  }
}

/** Công tắc 44×26 theo thiết kế, vùng chạm 44px. */
function Toggle({ checked, onChange, disabled, labelledBy }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; labelledBy: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={labelledBy} disabled={disabled} onClick={() => onChange(!checked)} className="flex h-11 w-[52px] shrink-0 cursor-pointer items-center justify-center rounded-ax-field outline-none focus-visible:shadow-[var(--ax-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50">
      <span className={cn("relative block h-[26px] w-11 rounded-full transition-colors", checked ? "bg-ax-primary" : "bg-[#8b919f]")}>
        <span className={cn("absolute top-[3px] size-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.25)] transition-[left]", checked ? "left-[21px]" : "left-[3px]")} />
      </span>
    </button>
  )
}

/* ============================== DESKTOP (≥ 1024px) ============================== */

function RadioChip({ on, onClick, children, round, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; round?: boolean; disabled?: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} disabled={disabled} className={cn("flex cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 items-center gap-2.5 border text-sm font-semibold text-ax-ink outline-none transition-colors focus-visible:shadow-[var(--ax-focus-ring)]", round ? "h-11 rounded-full px-4" : "min-h-12 rounded-ax-field py-0 pr-4 pl-2.5", on ? "border-ax-primary ax-grad-soft" : "border-ax-line bg-ax-surface hover:bg-ax-hover")}>
      {children}
    </button>
  )
}

export function FacebookPageDesktop({ page, assignees, sources, canPickAssignee, onReconnect, reconnecting }: PageDetailProps) {
  const { m, save } = useSaveWithUndo(page)
  const chk = useCheck(page)
  const [confirm, setConfirm] = useState(false)
  const [draft, setDraft] = useState({ active: page.is_active, assignee: page.default_assignee_id, source: page.contact_source_id })
  const state = pageState(page)
  const live = !page.disconnected
  const locked = !live || state === "bad"
  const dirty = live && (draft.active !== page.is_active || draft.assignee !== page.default_assignee_id || draft.source !== page.contact_source_id)
  const checks = pageChecks(page)
  const events = pageEvents(page)

  function saveDraft() {
    const body: { is_active?: boolean; default_assignee_id?: number; contact_source_id?: number } = {}
    const prev: typeof body = {}
    if (draft.active !== page.is_active) { body.is_active = draft.active; prev.is_active = page.is_active }
    if (draft.assignee !== page.default_assignee_id) { body.default_assignee_id = draft.assignee; prev.default_assignee_id = page.default_assignee_id }
    if (draft.source !== page.contact_source_id) { body.contact_source_id = draft.source; prev.contact_source_id = page.contact_source_id }
    save(body, "Đã lưu cấu hình", prev)
  }
  // Hoàn tác / làm mới từ máy chủ đổi giá trị gốc ⇒ bản nháp theo giá trị mới (chỉ khi người dùng chưa sửa dở).
  const [seen, setSeen] = useState(`${page.is_active}|${page.default_assignee_id}|${page.contact_source_id}`)
  const now = `${page.is_active}|${page.default_assignee_id}|${page.contact_source_id}`
  if (seen !== now) {
    setSeen(now)
    setDraft({ active: page.is_active, assignee: page.default_assignee_id, source: page.contact_source_id })
  }

  return (
    <div className="space-y-4">
      <StatusHero page={page} onCheck={chk.run} checking={chk.pending} onReconnect={onReconnect} reconnecting={reconnecting} />
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[1_1_640px] flex-col gap-4">
          <section aria-labelledby="fb-h-sk" className="ax-card px-6 py-5">
            <h2 id="fb-h-sk" className="ax-text-subhead">Tình trạng kết nối</h2>
            <p className="mt-1 mb-2 text-[13px] text-ax-ink-3" data-testid="fb-last-check">{page.token_checked_at ? `Kiểm lần cuối ${formatDateTime(page.token_checked_at)}` : "Chưa kiểm tra"}</p>
            {checks.map((c) => (
              <div key={c.title} className="flex items-start gap-3.5 border-t border-ax-divider py-3.5">
                <ToneMark tone={c.tone} mark={c.mark} />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold">{c.title} <span className={cn("ml-1.5 text-[13px] font-semibold", TEXT[c.tone])}>{c.tag}</span></div>
                  <div className="mt-0.5 text-sm text-ax-ink-2">{c.text}</div>
                </div>
              </div>
            ))}
            <p className="sr-only" data-testid="fb-page-posting">Đăng bài: {page.posting === "on" ? "đã nối" : page.posting === "removed" ? "đã gỡ" : "chưa nối"}</p>
          </section>

          <section aria-labelledby="fb-h-cf" className="ax-card overflow-hidden">
            <div className="px-6 py-5">
              <h2 id="fb-h-cf" className="ax-text-subhead mb-4">Cách nhận khách từ Page này</h2>
              <div className="flex items-center justify-between gap-4 border-b border-ax-divider pb-4">
                <div>
                  <div id="fb-lb-act" className="text-[15px] font-semibold">Nhận tin nhắn, bình luận và lead</div>
                  <div className="mt-0.5 text-[13px] text-ax-ink-2">{state === "bad" ? "Chưa đổi được cho tới khi nối lại Page." : draft.active ? "Đang bật. Tắt thì Page không đẩy gì về Trinity." : "Đang tắt. Bật để nhận lại."}</div>
                </div>
                <Toggle checked={draft.active} labelledBy="fb-lb-act" disabled={locked} onChange={(v) => setDraft((d) => ({ ...d, active: v }))} />
              </div>
              {!live && <p className="flex items-center gap-1.5 pt-4 text-sm text-ax-ink-2" data-testid="fb-page-disconnected"><PauseCircle className="size-4" aria-hidden />Đã ngắt — kết nối lại để bật</p>}
              {live && !page.is_active && !dirty && <p className="sr-only" data-testid="fb-page-off">Đã tắt: không nhận tin nhắn, bình luận và lead từ Fanpage này. Bật công tắc để nhận lại.</p>}
              <div role="radiogroup" aria-labelledby="fb-lb-as" className="py-[18px]">
                <div id="fb-lb-as" className="text-[15px] font-semibold">Người nhận khách đầu tiên</div>
                <div className="mt-0.5 mb-2.5 text-[13px] text-ax-ink-2">Khách nhắn vào Page được giao cho người này; sau đó có thể chuyển.</div>
                <div className="flex flex-wrap gap-2">
                  {assignees.map((p) => (
                    <RadioChip key={p.id} on={draft.assignee === p.id} disabled={locked || !canPickAssignee} onClick={() => setDraft((d) => ({ ...d, assignee: p.id }))}>
                      <Avatar kind="staff" size="default"><AvatarFallback>{initials(p.label)}</AvatarFallback></Avatar>{p.label}
                    </RadioChip>
                  ))}
                  {assignees.length === 0 && <span className="text-sm text-ax-ink-2">Chưa có người để giao.</span>}
                </div>
              </div>
              <div role="radiogroup" aria-labelledby="fb-lb-sr" className="border-t border-ax-divider pt-[18px]">
                <div id="fb-lb-sr" className="text-[15px] font-semibold">Ghi nguồn khách là</div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {sources.map((s) => (
                    <RadioChip round key={s.id} on={draft.source === s.id} disabled={locked} onClick={() => setDraft((d) => ({ ...d, source: s.id }))}>{s.label}</RadioChip>
                  ))}
                  {sources.length === 0 && <span className="text-sm text-ax-ink-2">{optLabel(sources, page.contact_source_id)}</span>}
                </div>
              </div>
            </div>
            {dirty && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ax-line bg-ax-sunken px-6 py-3">
                <span className="text-sm text-ax-ink-2">Có thay đổi chưa lưu. Fanpage vẫn chạy theo cấu hình cũ cho tới khi bạn lưu.</span>
                <div className="flex gap-2">
                  <Button variant="ax-secondary" size="ax" onClick={() => setDraft({ active: page.is_active, assignee: page.default_assignee_id, source: page.contact_source_id })}>Bỏ thay đổi</Button>
                  <Button variant="ax-primary" size="ax" onClick={saveDraft} disabled={m.update.isPending}>{m.update.isPending && <Spinner />}Lưu cấu hình</Button>
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
          <section aria-labelledby="fb-h-lg" className="ax-card px-6 py-5">
            <h2 id="fb-h-lg" className="ax-text-subhead mb-1.5">Nhật ký gần đây</h2>
            {events.map((e, i) => (
              <div key={i} className="flex gap-3 border-t border-ax-divider py-2.5">
                <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[e.tone])} />
                <div className="min-w-0"><div className="text-sm text-ax-ink">{e.text}</div><div className="mt-0.5 text-[12px] text-ax-ink-3">{e.when}</div></div>
              </div>
            ))}
          </section>

          <section aria-labelledby="fb-h-dg" className="ax-card px-6 py-5">
            <h2 id="fb-h-dg" className="ax-text-subhead mb-1">Ngắt kết nối</h2>
            <p className="mb-3 text-sm text-ax-ink-2">Huỷ đăng ký webhook, xoá token và tắt Page này. Hội thoại và khách đã tạo được giữ nguyên.</p>
            {live && !confirm && <Button variant="ax-danger" size="ax" onClick={() => setConfirm(true)}>Ngắt kết nối Page</Button>}
            {live && confirm && (
              <div role="alertdialog" aria-label="Xác nhận ngắt kết nối" className="rounded-ax-card border border-[var(--ax-danger-border)] bg-ax-danger-soft p-3.5">
                <div className="text-sm font-semibold text-[var(--ax-danger-ink)]">Ngắt &quot;{page.name}&quot;?</div>
                <div className="mt-1 mb-3 text-[13px] text-ax-ink-2">Khách nhắn vào Page sẽ không về Trinity nữa. Nối lại sau này sẽ không tự bật lại Page này.</div>
                <div className="flex gap-2">
                  <Button variant="ax-secondary" size="ax" onClick={() => setConfirm(false)}>Giữ kết nối</Button>
                  <Button variant="ax-danger" size="ax" disabled={m.remove.isPending} onClick={() => m.remove.mutate(page.id, { onSuccess: () => { setConfirm(false); toast.success(`Đã ngắt kết nối ${page.name}`) }, onError: (e) => toast.error(apiErrorMessage(e, "Không ngắt được")) })}>{m.remove.isPending && <Spinner />}Ngắt kết nối</Button>
                </div>
              </div>
            )}
            {!live && <p className="text-sm text-ax-ink-3">Page này đã ngắt. Dùng &quot;Kết nối lại&quot; ở đầu trang để nối lại.</p>}
          </section>
        </div>
      </div>
    </div>
  )
}

/* ============================== ĐIỆN THOẠI (< 1024px) ============================== */

function Group({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <>
      <h2 className="ax-text-group mt-5 mb-1.5 px-8 text-ax-ink-2">{title}</h2>
      <div className="mx-4 rounded-ax-card bg-ax-surface px-4 shadow-ax-card">{children}</div>
    </>
  )
}

const GUIDE_STEPS: Array<[string, string]> = [
  ["Mở Facebook", "Bấm nút bên dưới. Trinity chuyển sang hộp thoại đăng nhập của Facebook."],
  ["Chọn đúng Page", "Tick đúng Page cần nối. Các Page khác bỏ trống nếu không dùng."],
  ["Cho phép đủ quyền", "Giữ nguyên các quyền được tick sẵn, rồi bấm Xong. Trinity tự quay lại màn này."],
]
const GUIDE_PERMS = ["Đọc và trả lời tin nhắn Messenger", "Nhận khách từ Lead Ads", "Đọc bình luận trên bài viết", "Đăng bài lên Page (không bắt buộc)"]

/**
 * «Gửi hướng dẫn cho quản trị viên Page»: máy chủ soạn văn bản (không gửi gì), điện thoại mở bảng chia sẻ để người dùng chọn Zalo,
 * Messenger, mail…; không có bảng chia sẻ (hoặc bị chặn) thì chép vào bộ nhớ tạm. Người dùng đóng bảng chia sẻ ⇒ không báo gì.
 */
function useSendGuide(page: FacebookPageView) {
  const guide = useAdminGuide()
  const send = () =>
    guide.mutate(
      { id: page.id },
      {
        onError: (e) => toast.error(apiErrorMessage(e, "Chưa soạn được hướng dẫn")),
        onSuccess: async (g) => {
          if (typeof navigator.share === "function") {
            try {
              await navigator.share({ title: `Nối lại Fanpage ${g.page_name}`, text: g.text })
              return
            } catch (e) {
              if (e instanceof DOMException && e.name === "AbortError") return
            }
          }
          try {
            await navigator.clipboard.writeText(g.text)
            toast.success("Đã chép hướng dẫn. Dán vào Zalo hoặc tin nhắn để gửi cho quản trị viên Page.")
          } catch {
            toast.error("Không chép được hướng dẫn. Bạn thử lại hoặc dùng điện thoại khác.")
          }
        },
      },
    )
  return { send, pending: guide.isPending }
}

/** ketnoi-mobile2: hướng dẫn ba bước trước khi mở hộp thoại Facebook, kèm gửi hướng dẫn cho quản trị viên Page. */
function MobileGuide({ page, onBack, onReconnect, reconnecting }: { page: FacebookPageView; onBack: () => void; onReconnect: () => void; reconnecting: boolean }) {
  const sender = useSendGuide(page)
  return (
    <div data-testid="fb-guide">
      <div className="flex items-center px-2 pt-3">
        <button type="button" onClick={onBack} aria-label="Quay lại" className="flex h-11 cursor-pointer items-center gap-0.5 rounded-ax-field px-2.5 text-base text-ax-primary-ink outline-none focus-visible:shadow-[var(--ax-focus-ring)]"><ChevronLeft className="size-5" aria-hidden />{page.name}</button>
      </div>
      <div className="px-5 pt-0.5 pb-3.5">
        <h1 className="ax-text-title">Nối lại Fanpage</h1>
        <p className="mt-1.5 text-[15px] leading-snug text-ax-ink-2">Làm ba bước. Người thực hiện phải là quản trị viên của Page này trên Facebook.</p>
      </div>
      <HeroCard className="mx-4 p-0 py-1 max-sm:p-0 max-sm:py-1">
        <ol className="m-0 list-none p-0">
          {GUIDE_STEPS.map(([t, d], i) => (
            <li key={t} className={cn("flex gap-3.5 px-[18px] py-4", i > 0 && "border-t border-white/15")}>
              <span aria-hidden className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-full text-sm font-bold shadow-[inset_0_0_0_1px_rgba(255,255,255,.3)]", i === 0 ? "bg-white text-[#285680]" : "bg-[var(--ax-on-hero-tile)] text-white")}>{i + 1}</span>
              <div className="min-w-0 flex-1"><div className="ax-text-subhead text-white">{t}</div><div className="mt-0.5 text-sm leading-snug text-[var(--ax-on-hero-ink-2)]">{d}</div></div>
            </li>
          ))}
        </ol>
      </HeroCard>
      <h2 className="ax-text-group mt-5 mb-1.5 px-8 text-ax-ink-2">Quyền cần cấp</h2>
      <div className="mx-4 rounded-ax-card bg-ax-surface px-4 shadow-ax-card">
        {GUIDE_PERMS.map((t, i) => (
          <div key={t} className={cn("flex min-h-12 items-center gap-2.5 text-[15px]", i > 0 && "border-t border-ax-divider")}><span aria-hidden className="font-bold text-ax-success">✓</span>{t}</div>
        ))}
      </div>
      <p className="mx-8 mt-3 text-[13px] leading-snug text-ax-ink-3">Thiếu một quyền thì Page vẫn nối được nhưng sẽ không nhận đủ tin. Trinity báo rõ quyền nào thiếu.</p>
      <StickyActionBar layout="mobile">
        <div className="flex w-full flex-col gap-1">
          <Button variant="ax-primary" size="ax-lg" onClick={onReconnect} disabled={reconnecting}>{reconnecting && <Spinner />}{reconnecting ? "Đang mở Facebook" : "Mở Facebook để nối lại"}</Button>
          <Button variant="ax-ghost" size="ax-lg" onClick={sender.send} disabled={sender.pending} className="h-12 text-[15px] font-normal text-ax-ink-2">{sender.pending && <Spinner />}Gửi hướng dẫn cho quản trị viên Page</Button>
        </div>
      </StickyActionBar>
    </div>
  )
}

export function FacebookPageMobile({ page, assignees, sources, canPickAssignee, onReconnect, reconnecting, backHref }: PageDetailProps & { backHref: string }) {
  const { m, save } = useSaveWithUndo(page)
  const chk = useCheck(page)
  const [pick, setPick] = useState(false)
  const [ask, setAsk] = useState(false)
  const [guide, setGuide] = useState(false)
  const state = pageState(page)
  const live = !page.disconnected
  const locked = !live || state === "bad"
  const checks = pageChecks(page)

  if (guide) return <MobileGuide page={page} onBack={() => setGuide(false)} onReconnect={onReconnect} reconnecting={reconnecting} />

  return (
    <div className="pb-6">
      <div className="flex items-center px-2 pt-3">
        <Link href={backHref} aria-label="Quay lại Kết nối" className="flex h-11 items-center gap-0.5 rounded-ax-field px-2.5 text-base text-ax-primary-ink outline-none focus-visible:shadow-[var(--ax-focus-ring)]"><ChevronLeft className="size-5" aria-hidden />Kết nối</Link>
      </div>
      <div className="px-5 pt-0.5 pb-3.5">
        <div className="text-[13px] text-ax-ink-2">Fanpage Facebook</div>
        <h1 className="ax-text-title">{page.name}</h1>
      </div>
      <div className="mx-4">
        <StatusHero mobile page={page} onCheck={chk.run} checking={chk.pending} onReconnect={() => setGuide(true)} reconnecting={reconnecting} />
      </div>

      <Group title="Tình trạng">
        {checks.map((c, i) => (
          <div key={c.title} className={cn("flex min-h-14 items-center gap-3 py-2.5", i > 0 && "border-t border-ax-divider")}>
            <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", DOT[c.tone])} />
            <div className="min-w-0 flex-1"><div className="text-[15px] font-semibold">{c.title}</div><div className="text-[13px] text-ax-ink-2">{c.text}</div></div>
            <span className={cn("text-[13px] font-semibold", TEXT[c.tone])}>{c.tag}</span>
          </div>
        ))}
        <p className="sr-only" data-testid="fb-page-posting">Đăng bài: {page.posting === "on" ? "đã nối" : page.posting === "removed" ? "đã gỡ" : "chưa nối"}</p>
      </Group>

      <Group title="Cách nhận khách">
        <div className="flex min-h-14 items-center justify-between gap-3">
          <span id="fb-m-act" className="text-[15px] font-semibold">Nhận tin và lead</span>
          <Toggle checked={page.is_active && live} labelledBy="fb-m-act" disabled={locked || m.update.isPending} onChange={(v) => save({ is_active: v }, v ? "Đã bật nhận tin" : "Đã tắt nhận tin", { is_active: !v })} />
        </div>
        {!live && <p className="pb-3 text-[13px] text-ax-ink-2" data-testid="fb-page-disconnected">Đã ngắt — kết nối lại để bật</p>}
        {live && !page.is_active && <p className="sr-only" data-testid="fb-page-off">Đã tắt: không nhận tin nhắn, bình luận và lead từ Fanpage này. Bật công tắc để nhận lại.</p>}
        <button type="button" onClick={() => setPick(true)} disabled={locked || !canPickAssignee} className="flex min-h-14 w-full cursor-pointer items-center gap-2 border-t border-ax-divider text-left outline-none focus-visible:shadow-[var(--ax-focus-ring)] disabled:cursor-default">
          <span className="flex-1 text-[15px] font-semibold">Người nhận khách</span>
          <span className="text-[15px] text-ax-ink-2">{optLabel(assignees, page.default_assignee_id)}</span>
          {canPickAssignee && !locked && <ChevronRight className="size-4 text-ax-ink-3" aria-hidden />}
        </button>
        <div className="flex min-h-14 items-center gap-2 border-t border-ax-divider">
          <span className="flex-1 text-[15px] font-semibold">Nguồn khách</span>
          <span className="text-[15px] text-ax-ink-2">{optLabel(sources, page.contact_source_id)}</span>
        </div>
      </Group>

      {live && <div className="mx-4 mt-5"><Button variant="ax-danger" size="ax-lg" className="w-full" onClick={() => setAsk(true)}>Ngắt kết nối Page</Button></div>}

      <BottomSheet open={pick} onOpenChange={setPick}>
        <BottomSheetContent title="Người nhận khách">
          <div role="radiogroup" aria-label="Người nhận khách">
            {assignees.map((p) => {
              const on = p.id === page.default_assignee_id
              return (
                <BottomSheetClose key={p.id} render={<button type="button" role="radio" aria-checked={on} className="flex min-h-14 w-full cursor-pointer items-center gap-3 text-left outline-none focus-visible:shadow-[var(--ax-focus-ring)]" onClick={() => { if (!on) save({ default_assignee_id: p.id }, "Đã đổi người nhận khách", { default_assignee_id: page.default_assignee_id }) }} />}>
                  <Avatar kind="staff"><AvatarFallback>{initials(p.label)}</AvatarFallback></Avatar>
                  <span className="flex-1 text-base font-semibold">{p.label}</span>
                  <span className="text-sm font-semibold text-ax-primary-ink">{on ? "Đã chọn" : ""}</span>
                </BottomSheetClose>
              )
            })}
          </div>
        </BottomSheetContent>
      </BottomSheet>

      <BottomSheet open={ask} onOpenChange={setAsk}>
        <BottomSheetContent title={`Ngắt "${page.name}"?`} description="Khách nhắn vào Page sẽ không về Trinity nữa. Hội thoại và khách đã có được giữ nguyên.">
          <Button variant="ax-danger" size="ax-lg" className="w-full" disabled={m.remove.isPending} onClick={() => m.remove.mutate(page.id, { onSuccess: () => { setAsk(false); toast.success("Đã ngắt kết nối") }, onError: (e) => toast.error(apiErrorMessage(e, "Không ngắt được")) })}>{m.remove.isPending && <Spinner />}Ngắt kết nối</Button>
          <BottomSheetClose render={<Button variant="ax-ghost" size="ax-lg" className="w-full" />}>Giữ kết nối</BottomSheetClose>
        </BottomSheetContent>
      </BottomSheet>
    </div>
  )
}
