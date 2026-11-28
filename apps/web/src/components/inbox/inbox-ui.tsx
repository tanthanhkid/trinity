"use client"

/* =============================================================================
 * Khung hộp thư theo thiết kế «Ánh xanh» (hopthu-desktop / hopthu-mobile) — CHỈ TRÌNH BÀY, không gọi API.
 *   desktop (≥1024px): ba thẻ rời nhau — danh sách hội thoại · luồng tin + ô trả lời · hồ sơ khách (≥1280px)
 *   điện thoại (<1024px): MỘT cột tại một lúc (danh sách ⇄ hội thoại); hội thoại mở ra CHIẾM TOÀN MÀN (che thanh đầu app
 *     và tiêu đề trang, như hopthu-mobile): đầu là khối nhấn xanh có chip SĐT / giai đoạn / hẹn nhắc + nút «Hồ sơ» mở khay đáy
 * Mỗi kênh (Zalo OA, Fanpage Facebook) tự lấy dữ liệu + gửi tin bằng hook sẵn có của nó rồi đổ vào đây.
 * Mọi chuỗi từ khách/BE hiển thị bằng text node của React.
 * ========================================================================== */

import { useEffect, useRef, type ReactNode } from "react"
import { ArrowLeft, Loader2, Search, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AX_INPUT_CLASS, Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { PersonAvatar } from "@/components/ui/avatar"
import { HeroCard } from "@/components/ui/hero-card"
import { formatTimeVn, todayVn, vnDateKey } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ErrorState } from "@/components/ui/error-state"
import { useOffline } from "@/components/offline-banner"

export type InboxChannel = "zalo" | "facebook"

/** Nhãn kênh dưới tên hội thoại (thiết kế: chữ, không logo). */
const CHANNEL_LABEL: Record<InboxChannel, string> = { zalo: "Zalo OA", facebook: "Messenger" }

/** Giờ ngắn cho danh sách: hôm nay "09:31", hôm qua "Hôm qua", còn lại "dd/mm". */
export function inboxTimeLabel(iso: string | null | undefined, today = todayVn()): string {
  if (!iso) return ""
  const key = vnDateKey(iso)
  if (!key) return ""
  if (key === today) return formatTimeVn(iso)
  const y = new Date(`${today}T00:00:00+07:00`)
  y.setDate(y.getDate() - 1)
  if (key === vnDateKey(y)) return "Hôm qua"
  const [, m, d] = key.split("-")
  return `${d}/${m}`
}

/** Nhãn vạch ngày trong luồng tin. */
export function inboxDayLabel(key: string, today = todayVn()): string {
  if (key === today) return "Hôm nay"
  const y = new Date(`${today}T00:00:00+07:00`)
  y.setDate(y.getDate() - 1)
  if (key === vnDateKey(y)) return "Hôm qua"
  const [yy, m, d] = key.split("-")
  return `${d}/${m}/${yy}`
}

/** Avatar khách «Ánh xanh»: bo 30%, chữ cái đầu; có ảnh từ CDN của kênh thì dùng ảnh. */
export function InboxAvatar({ name, src, size = "md" }: { name: string; src?: string | null; channel?: InboxChannel; size?: "sm" | "md" | "lg" }) {
  return <PersonAvatar kind="customer" name={name} src={src ?? undefined} size={size === "md" ? "lg" : size === "lg" ? "xl" : "default"} />
}

/** Thẻ của một cột trên desktop: gradient nhạt, viền, bo 16 (thiết kế), cuộn trong thẻ. */
const COL_CARD = "lg:ax-card lg:rounded-[16px] lg:overflow-hidden"

/**
 * Hội thoại đang mở dưới 1024px: lớp toàn màn (z-50 như ngăn chi tiết thẻ Kanban — khay «Hồ sơ khách» và toast portal sau nên
 * vẫn nằm trên), nền trang mobile. ≥1024px không đổi gì.
 */
const THREAD_FULLSCREEN = "max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:rounded-none max-lg:border-0 max-lg:shadow-none max-lg:ax-page"

/**
 * Khung hộp thư. Dưới 1024px: chỉ một cột tại một lúc — danh sách trong một thẻ liền; hội thoại mở ra thì toàn màn.
 * ≥1024px: danh sách 300 + hội thoại; ≥1280px: thêm cột hồ sơ khách (320, ≥1536px: 372) — ba thẻ rời, cách 12.
 */
export function InboxFrame({
  list,
  thread,
  side,
  threadOpen,
  listTop,
  className,
}: {
  list: ReactNode
  /** Phần đầu cột danh sách (vd tab kênh ở màn Hộp thư) — luôn hiện trên danh sách. */
  listTop?: ReactNode
  thread: ReactNode
  side?: ReactNode
  /** Đang mở một hội thoại? (điện thoại: ẩn danh sách, hiện hội thoại) */
  threadOpen: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "grid h-[min(78dvh,780px)] min-h-[480px] overflow-hidden rounded-[var(--ax-radius-sheet)] ax-card",
        "lg:gap-3 lg:overflow-visible lg:rounded-none lg:border-0 lg:bg-transparent lg:shadow-none lg:[background:none]",
        "lg:grid-cols-[300px_minmax(0,1fr)]",
        side ? "xl:grid-cols-[300px_minmax(0,1fr)_320px] 2xl:grid-cols-[300px_minmax(0,1fr)_372px]" : "",
        className,
      )}
    >
      <section aria-label="Danh sách hội thoại" className={cn("min-h-0 min-w-0 flex-col lg:flex", COL_CARD, threadOpen ? "hidden" : "flex")}>{listTop}{list}</section>
      <section aria-label="Hội thoại" data-testid="inbox-thread" className={cn("min-h-0 min-w-0 flex-col lg:flex", COL_CARD, threadOpen ? cn("flex", THREAD_FULLSCREEN) : "hidden")}>{thread}</section>
      {side ? <aside aria-label="Hồ sơ khách" className={cn("hidden min-h-0 min-w-0 overflow-y-auto xl:block", COL_CARD)}>{side}</aside> : null}
    </div>
  )
}

export function ConversationItem({
  name,
  preview,
  time,
  unread,
  active,
  channel,
  avatarUrl,
  dot,
  onClick,
}: {
  name: string
  preview: string
  time: string
  unread: number
  active: boolean
  channel: InboxChannel
  avatarUrl?: string | null
  /** Chấm trạng thái bên phải: "open" = còn trả lời được, "closed" = hết cửa sổ trả lời. */
  dot?: { tone: "open" | "closed"; label: string }
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        "flex min-h-[72px] w-full items-start gap-2.5 border-b border-ax-divider px-3 py-3 text-left transition-colors duration-150 ease-out",
        "outline-none focus-visible:shadow-[inset_var(--ax-focus-ring)] focus-visible:bg-ax-hover",
        active ? "bg-ax-primary-soft" : "bg-transparent hover:bg-ax-hover",
      )}
    >
      <InboxAvatar name={name} src={avatarUrl} channel={channel} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-[15px] tracking-[-0.011em]", active ? "text-ax-primary-ink" : "text-ax-ink", unread > 0 ? "font-bold" : "font-semibold")}>{name}</span>
          <span className={cn("ax-amount shrink-0 text-[12px] font-normal", unread > 0 ? "font-semibold text-ax-primary-ink" : "text-ax-ink-3")}>{time}</span>
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-[13px]", unread > 0 ? "font-medium text-ax-ink" : "text-ax-ink-2")}>{preview}</span>
          {unread > 0 ? (
            <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-ax-primary px-1.5 text-[12px] font-semibold tabular-nums text-white" aria-label={`${unread} tin chưa đọc`}>
              {unread}
            </span>
          ) : dot ? (
            <span
              title={dot.label}
              aria-label={dot.label}
              className={cn("size-2 shrink-0 rounded-full", dot.tone === "open" ? "bg-[var(--ax-success)]" : "border-2 border-ax-ink-3")}
            />
          ) : null}
        </span>
        <span className="text-[12px] text-ax-ink-3">{CHANNEL_LABEL[channel]}</span>
      </span>
    </button>
  )
}

/**
 * Đầu một hội thoại.
 *  - desktop: dòng tên + kênh trên nền thẻ, bên phải `aside` (nhãn trạng thái) và nút «Hồ sơ» dưới 1280px
 *  - điện thoại: khối nhấn xanh (mỗi màn đúng một): quay lại · tên · «Hồ sơ», dưới là hàng chip `chips`; dòng phụ = `mobileSub`
 *    (thiết kế: «Kênh · Phụ trách …»), không có thì dùng `sub`
 */
export function ThreadHeader({
  name,
  sub,
  channel,
  avatarUrl,
  onBack,
  aside,
  chips,
  onOpenProfile,
  mobileSub,
}: {
  name: string
  sub: string
  /** Dòng phụ trên điện thoại (thiết kế hopthu-mobile: «Zalo OA · Phụ trách Linh»). */
  mobileSub?: string
  channel: InboxChannel
  avatarUrl?: string | null
  onBack: () => void
  aside?: ReactNode
  /** Hàng chip dưới tên trên điện thoại (SĐT / giai đoạn / hẹn nhắc) — mỗi chip tự là nút. */
  chips?: ReactNode
  /** Mở hồ sơ khách ở khay đáy (điện thoại và desktop hẹp, nơi chưa có cột hồ sơ). */
  onOpenProfile?: () => void
}) {
  return (
    <>
      <HeroCard className="shrink-0 rounded-none border-x-0 border-t-0 p-0 px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-0 lg:hidden max-sm:rounded-none max-sm:p-0 max-sm:px-2 max-sm:pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <div className="flex items-center gap-1">
          <Button variant="ax-on-hero-secondary" size="ax-icon" className="shrink-0 border-0 bg-transparent" onClick={onBack} aria-label="Quay lại danh sách">
            <ArrowLeft className="size-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[18px] font-bold tracking-[-0.011em] text-white">{name}</p>
            <p className="truncate text-[13px] text-[var(--ax-on-hero-ink-2)]">{mobileSub ?? sub}</p>
          </div>
          {onOpenProfile ? (
            <Button variant="ax-on-hero" size="ax" className="mr-2 shrink-0" onClick={onOpenProfile} aria-label="Mở hồ sơ khách">
              Hồ sơ
            </Button>
          ) : null}
        </div>
        {chips ? <div className="flex gap-2 overflow-x-auto px-2 pt-2 pb-2.5">{chips}</div> : <div className="h-2" />}
      </HeroCard>
      <div className="hidden items-center justify-between gap-3 border-b border-ax-line px-4 py-3 lg:flex">
        <div className="flex min-w-0 items-center gap-3">
          <InboxAvatar name={name} src={avatarUrl} channel={channel} />
          <div className="min-w-0">
            <p className="truncate text-[16px] font-bold tracking-[-0.011em] text-ax-ink">{name}</p>
            <p className="truncate text-[13px] text-ax-ink-2">{sub}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {aside}
          {onOpenProfile ? (
            <Button variant="ax-secondary" size="ax" className="xl:hidden" onClick={onOpenProfile} aria-label="Mở hồ sơ khách">
              Hồ sơ
            </Button>
          ) : null}
        </div>
      </div>
    </>
  )
}

/**
 * Chip trên khối nhấn ở đầu hội thoại (điện thoại): `solid` nền trắng · `dashed` thiếu thông tin (nền vàng nhạt, viền đứt, chữ
 * cảnh báo — thiết kế «Thêm số điện thoại») · `glass` nền xanh thẫm trong.
 */
export function HeroChip({ tone = "solid", onClick, children }: { tone?: "solid" | "dashed" | "glass"; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-11 shrink-0 cursor-pointer rounded-full px-3.5 text-[15px] font-semibold tracking-[-0.011em] whitespace-nowrap outline-none transition-colors duration-150 focus-visible:shadow-[0_0_0_2px_#1A3C5D,0_0_0_4px_#fff]",
        tone === "solid" && "border border-transparent bg-white text-[#17181C] hover:bg-[#EEF4FA]",
        tone === "dashed" && "border-[1.5px] border-dashed border-ax-warn bg-ax-warn-soft text-ax-warn hover:brightness-[.97]",
        tone === "glass" && "border border-[var(--ax-on-hero-secondary-border)] bg-[var(--ax-on-hero-secondary)] font-normal text-white hover:bg-[var(--ax-on-hero-secondary-hover)]",
      )}
    >
      {children}
    </button>
  )
}

/** Nhãn nhỏ có chấm (vd "Còn trả lời được" / "Quá 48 giờ"). Màu trạng thái dùng token «Ánh xanh». */
export function StatusPill({ tone, children }: { tone: "ok" | "warn"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "hidden shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold sm:inline-flex",
        tone === "ok" ? "bg-[var(--ax-success-soft)] text-[var(--ax-success)]" : "bg-[var(--ax-warn-soft)] text-[var(--ax-warn)]",
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  )
}

export interface InboxMessage {
  id: string
  direction: "in" | "out"
  text: string
  at: string
  /** Dòng nhỏ dưới bong bóng, vd "Chị Lan · 09:12" — để trống thì chỉ giờ. */
  who?: string
  failed?: string | null
  /** SĐT máy chủ dò trong tin khách (Zalo OA) — chỗ bám của nút «Lưu SĐT vào hồ sơ». */
  phones?: readonly string[]
}

/**
 * Luồng tin: vạch ngày + bong bóng khách (trái, nền lõm) / nhân viên (phải, xanh chính). Tự cuộn xuống tin mới nhất.
 * `afterMessage` = chỗ chừa dưới từng bong bóng cho hành động theo tin (vd nút «Lưu SĐT vào hồ sơ», `components/inbox/save-phone.tsx`).
 */
export function MessageThread({
  messages,
  loading,
  error,
  afterMessage,
}: {
  messages: readonly InboxMessage[]
  loading?: boolean
  error?: boolean
  afterMessage?: (m: InboxMessage) => ReactNode
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }) }, [messages.length])
  const today = todayVn()
  const days = messages.map((m) => vnDateKey(m.at))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ax-surface px-3 py-4 max-lg:bg-transparent sm:px-4 lg:p-4">
      {loading && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-ax-ink-2">
          <Loader2 className="size-4 animate-spin" /> Đang tải...
        </div>
      )}
      {error && <ErrorState compact className="py-6" title="Không tải được tin nhắn" message="Kiểm tra Internet rồi mở lại hội thoại; vẫn lỗi thì tải lại trang." />}
      <div className="flex flex-col gap-2.5">
        {messages.map((m, i) => {
          const day = days[i]
          // Vạch ngày khi ngày khác tin đứng trước (bỏ qua tin không có ngày hợp lệ).
          const prevDay = days.slice(0, i).reverse().find(Boolean) ?? ""
          const sep = day && day !== prevDay
          const out = m.direction === "out"
          const time = formatTimeVn(m.at)
          const failed = m.failed !== undefined && m.failed !== null
          return (
            <div key={m.id}>
              {sep && (
                <div className="my-2 flex justify-center">
                  <span className="rounded-full bg-ax-sunken px-2.5 py-0.5 text-[12px] font-medium text-ax-ink-2 max-lg:bg-ax-surface">
                    {inboxDayLabel(day, today)}
                  </span>
                </div>
              )}
              <div className={cn("flex flex-col gap-1.5", out ? "items-end" : "items-start")}>
                <div
                  className={cn(
                    "max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-base leading-[1.45] lg:max-w-[72%] lg:rounded-[14px] lg:text-[15px]",
                    out ? "bg-ax-primary text-white" : "bg-ax-sunken text-ax-ink max-lg:bg-ax-surface max-lg:shadow-[var(--ax-shadow-soft)]",
                    failed && "opacity-60",
                  )}
                >
                  {m.text}
                </div>
                <p className="px-1 text-[12px] text-ax-ink-3">
                  {m.who ? `${m.who} · ${time}` : time}
                  {failed && <span className="text-[var(--ax-danger-ink)]"> · Lỗi{m.failed ? `: ${m.failed}` : ""}</span>}
                </p>
                {afterMessage?.(m)}
              </div>
            </div>
          )
        })}
      </div>
      <div ref={endRef} />
    </div>
  )
}

/** Câu soạn sẵn (chỉ điền vào ô, người dùng đọc lại rồi mới gửi) — thiết kế desktop. */
const QUICK_REPLIES = [
  { label: "Xin số điện thoại", text: "Chị cho em xin số điện thoại để em tư vấn kỹ hơn nhé." },
  { label: "Gửi bảng giá", text: "Em gửi chị bảng giá tham khảo, chị xem giúp em nhé." },
] as const

/** Ô trả lời: Enter gửi, Shift+Enter xuống dòng. `notice` hiện phía trên khi kênh không cho gửi. */
export function Composer({
  value,
  onChange,
  onSend,
  pending,
  disabled,
  placeholder,
  ariaLabel,
  notice,
  maxLength,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  pending: boolean
  disabled?: boolean
  placeholder: string
  ariaLabel?: string
  notice?: ReactNode
  maxLength?: number
}) {
  // Mất mạng: vẫn gõ được (giữ nháp) nhưng khoá Gửi và nói rõ — không để tin "gửi" mà không đi.
  const offline = useOffline()
  return (
    <div className="ax-grad-composer shrink-0 border-t border-ax-line p-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:flex lg:flex-col lg:gap-2 lg:p-3">
      {notice}
      {offline && <p role="status" className="mb-2 text-sm text-[var(--ax-warn)]">Đang mất mạng — tin chưa gửi được. Nội dung vẫn giữ trong ô, có mạng lại thì bấm Gửi.</p>}
      {!disabled && (
        <div className="hidden flex-wrap gap-2 lg:flex">
          {QUICK_REPLIES.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => onChange(value.trim() ? `${value.trimEnd()} ${q.text}` : q.text)}
              className="relative h-9 cursor-pointer rounded-full border border-ax-btn-border bg-ax-surface px-3 text-[13px] text-ax-ink-2 shadow-[var(--ax-shadow-soft)] outline-none transition-colors duration-150 hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]"
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          rows={1}
          aria-label={ariaLabel ?? "Soạn trả lời"}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          className={cn(AX_INPUT_CLASS, "max-h-40 min-h-12 resize-none rounded-3xl px-4 py-3 text-base leading-snug lg:rounded-[var(--ax-radius-field)] lg:text-[15px]")}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!disabled && !offline && value.trim() && !pending) onSend()
            }
          }}
        />
        <Button
          variant="ax-primary"
          size="ax-lg"
          className="size-12 shrink-0 rounded-full p-0 lg:w-auto lg:rounded-[var(--ax-radius-field)] lg:px-[22px]"
          disabled={disabled || offline || !value.trim() || pending}
          onClick={onSend}
          aria-label="Gửi"
        >
          {pending ? <Loader2 className="size-5 animate-spin" /> : <Send className="size-5 lg:hidden" />}
          <span className="max-lg:hidden">Gửi</span>
        </Button>
      </div>
    </div>
  )
}

/** Khối thông tin ở cột phải: tiêu đề nhỏ in hoa + các dòng nhãn/giá trị. */
export function SideSection({ title, rows, children }: { title: string; rows?: { label: string; value: ReactNode }[]; children?: ReactNode }) {
  return (
    <section className="border-b border-ax-divider px-4 py-4 last:border-b-0">
      <h3 className="ax-text-group mb-2.5">{title}</h3>
      {rows && rows.length > 0 && (
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[15px]">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-[13px] text-ax-ink-2">{r.label}</dt>
              <dd className="min-w-0 break-words text-ax-ink">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </section>
  )
}

/** Trạng thái trống trong một cột — dáng «Ánh xanh»: khối lõm có quầng, icon nét, tiêu đề + lời nhắn. */
export function InboxEmpty({ icon, title, children }: { icon?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-4">
      <div className="ax-grad-empty flex w-full max-w-xs flex-col items-center gap-2 rounded-[var(--ax-radius-card)] px-5 py-7 text-center shadow-[var(--ax-shadow-inset)]">
        {icon ? <span className="text-ax-primary-ink [&_svg]:size-5">{icon}</span> : null}
        {title ? <p className="text-[15px] font-semibold text-ax-ink">{title}</p> : null}
        <p className="text-[13px] leading-5 text-ax-ink-2">{children}</p>
      </div>
    </div>
  )
}

/** Khách nhắn sau tin cuối của mình ⇒ đang chờ mình trả lời. */
export function awaitingReply(s: { last_inbound_at: string | null; last_message_at: string | null }): boolean {
  if (!s.last_inbound_at) return false
  return !s.last_message_at || Date.parse(s.last_inbound_at) >= Date.parse(s.last_message_at)
}

/** Đầu cột danh sách: ô tìm + (tuỳ chọn) lọc Tất cả / Chưa trả lời. Dùng chung cho mọi hộp thư. */
export function InboxListToolbar({ q, onQ, awaiting }: {
  q: string
  onQ: (q: string) => void
  awaiting?: { on: boolean; count: number; onChange: (on: boolean) => void }
}) {
  const seg = (on: boolean) =>
    cn(
      "relative h-9 flex-1 cursor-pointer rounded-[var(--ax-radius-field)] px-2.5 text-[13px] font-semibold outline-none transition-colors duration-150 ease-out focus-visible:shadow-[var(--ax-focus-ring)] max-sm:h-11",
      on ? "bg-ax-primary-soft text-ax-primary-ink" : "text-ax-ink-2 hover:bg-ax-hover",
    )
  return (
    <div className="flex flex-col gap-2 border-b border-ax-line p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ax-ink-3" />
        <Input variant="ax" className="pl-9" placeholder="Tìm theo tên hoặc SĐT" aria-label="Tìm hội thoại" value={q} onChange={(e) => onQ(e.target.value)} />
      </div>
      {awaiting ? (
        <div className="flex gap-1" role="group" aria-label="Lọc hội thoại">
          <button type="button" aria-pressed={!awaiting.on} onClick={() => awaiting.onChange(false)} className={seg(!awaiting.on)}>Tất cả</button>
          <button type="button" aria-pressed={awaiting.on} onClick={() => awaiting.onChange(true)} className={seg(awaiting.on)} data-testid="inbox-awaiting">
            Chưa trả lời{awaiting.count > 0 ? ` (${awaiting.count})` : ""}
          </button>
        </div>
      ) : null}
    </div>
  )
}
