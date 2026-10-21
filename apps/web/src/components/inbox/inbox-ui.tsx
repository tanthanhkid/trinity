"use client"

/* =============================================================================
 * Khung hộp thư 3 cột theo bản demo giao diện mới — CHỈ TRÌNH BÀY, không gọi API.
 *   cột trái: danh sách hội thoại (avatar + dấu kênh, xem trước, giờ, chấm trạng thái)
 *   cột giữa: luồng tin (bong bóng khách / nhân viên, vạch ngày) + ô trả lời
 *   cột phải: thông tin khách (chỉ ≥1280px)
 * Mỗi kênh (Zalo OA, Fanpage Facebook) tự lấy dữ liệu + gửi tin bằng hook sẵn có của nó rồi đổ vào đây.
 * Mọi chuỗi từ khách/BE hiển thị bằng text node của React.
 * ========================================================================== */

import { useEffect, useRef, type ReactNode } from "react"
import { ArrowLeft, Loader2, Search, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ShellAvatar } from "@/components/app-shell/avatar"
import { formatTimeVn, todayVn, vnDateKey } from "@/lib/format"
import { BRAND_LOGOS, type BrandKey } from "@/lib/brand-logos"
import { cn } from "@/lib/utils"
import { ErrorState } from "@/components/ui/error-state"
import { useOffline } from "@/components/offline-banner"

export type InboxChannel = "zalo" | "facebook" | "google"

/** Dấu kênh = logo chính thức (Messenger cho tin Fanpage). */
const CHANNEL_MARK: Record<InboxChannel, { label: string; brand: BrandKey }> = {
  zalo: { label: "Zalo", brand: "zalo" },
  facebook: { label: "Messenger", brand: "messenger" },
  google: { label: "Google", brand: "google_business" },
}

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

export function InboxAvatar({ name, src, channel, size = "md" }: { name: string; src?: string | null; channel: InboxChannel; size?: "sm" | "md" }) {
  const mark = CHANNEL_MARK[channel]
  const box = size === "md" ? "size-10" : "size-8"
  return (
    <span className={cn("relative shrink-0", box)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- ảnh đại diện từ CDN của kênh (Zalo), không qua next/image
        <img src={src} alt="" referrerPolicy="no-referrer" className={cn("rounded-full object-cover", box)} />
      ) : (
        <ShellAvatar name={name} size={size === "md" ? "lg" : "md"} className="!rounded-full text-sm" />
      )}
      <span
        aria-label={mark.label}
        title={mark.label}
        className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-[5px] bg-white ring-2 ring-[var(--card)]"
        data-brand={mark.brand}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- logo tĩnh trong /public */}
        <img src={BRAND_LOGOS[mark.brand]} alt="" className="size-3 object-contain" />
      </span>
    </span>
  )
}

/**
 * Khung 3 cột. Điện thoại/iPad dọc: chỉ một cột tại một lúc (danh sách ⇄ hội thoại);
 * ≥768px: danh sách + hội thoại; ≥1280px: thêm cột thông tin khách.
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
        "grid h-[min(78dvh,780px)] min-h-[480px] overflow-hidden rounded-xl bg-[var(--card)] ring-1 ring-foreground/8 shadow-[var(--shadow-card)]",
        "md:grid-cols-[300px_minmax(0,1fr)]",
        side ? "xl:grid-cols-[300px_minmax(0,1fr)_272px]" : "",
        className,
      )}
    >
      <div className={cn("min-h-0 min-w-0 flex-col border-[var(--border)] md:flex md:border-r", threadOpen ? "hidden" : "flex")}>{listTop}{list}</div>
      <div className={cn("min-h-0 min-w-0 flex-col md:flex", threadOpen ? "flex" : "hidden")}>{thread}</div>
      {side ? <aside className="hidden min-h-0 min-w-0 overflow-y-auto border-l border-[var(--border)] xl:block">{side}</aside> : null}
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
        "relative flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-150 ease-out max-md:min-h-14",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20",
        active
          ? "bg-primary/[0.07] before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-primary"
          : "hover:bg-[var(--muted)]",
      )}
    >
      <InboxAvatar name={name} src={avatarUrl} channel={channel} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-sm text-foreground", unread > 0 ? "font-semibold" : "font-medium")}>{name}</span>
          <span className={cn("shrink-0 text-xs tabular-nums", unread > 0 ? "font-medium text-primary" : "text-muted-foreground")}>{time}</span>
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className={cn("truncate text-sm", unread > 0 ? "text-foreground" : "text-muted-foreground")}>{preview}</span>
          {unread > 0 ? (
            <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] px-1.5 text-xs font-semibold tabular-nums text-[var(--primary-foreground)]" aria-label={`${unread} tin chưa đọc`}>
              {unread}
            </span>
          ) : dot ? (
            <span
              title={dot.label}
              aria-label={dot.label}
              className={cn(
                "size-2 shrink-0 rounded-full",
                dot.tone === "open" ? "bg-[var(--color-app-green)]" : "border-2 border-[var(--color-app-faint)]",
              )}
            />
          ) : null}
        </span>
      </span>
    </button>
  )
}

export function ThreadHeader({
  name,
  sub,
  channel,
  avatarUrl,
  onBack,
  aside,
}: {
  name: string
  sub: string
  channel: InboxChannel
  avatarUrl?: string | null
  onBack: () => void
  aside?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 sm:px-4">
      <Button variant="ghost" size="icon" className="shrink-0 md:hidden max-md:size-11" onClick={onBack} aria-label="Quay lại danh sách">
        <ArrowLeft className="size-4" />
      </Button>
      <InboxAvatar name={name} src={avatarUrl} channel={channel} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">{name}</p>
        <p className="truncate text-sm text-muted-foreground">{sub}</p>
      </div>
      {aside}
    </div>
  )
}

/** Nhãn nhỏ có chấm (vd "Còn trả lời được" / "Quá 48 giờ"). */
export function StatusPill({ tone, children }: { tone: "ok" | "warn"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "hidden shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-sm font-medium sm:inline-flex",
        tone === "ok"
          ? "bg-[var(--color-app-tag-green-bg)] text-[var(--color-app-tag-green-ink)]"
          : "bg-[var(--color-app-tag-amber-bg)] text-[var(--color-app-tag-amber-ink)]",
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
}

/** Luồng tin: vạch ngày + bong bóng khách (trái, nền thẻ) / nhân viên (phải, nền đậm). Tự cuộn xuống tin mới nhất. */
export function MessageThread({
  messages,
  loading,
  error,
}: {
  messages: readonly InboxMessage[]
  loading?: boolean
  error?: boolean
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }) }, [messages.length])
  const today = todayVn()
  const days = messages.map((m) => vnDateKey(m.at))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--background)] px-3 py-4 sm:px-5">
      {loading && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Đang tải...
        </div>
      )}
      {error && <ErrorState compact className="py-6" title="Không tải được tin nhắn" message="Kiểm tra Internet rồi mở lại hội thoại; vẫn lỗi thì tải lại trang." />}
      <div className="space-y-3">
        {messages.map((m, i) => {
          const day = days[i]
          // Vạch ngày khi ngày khác tin đứng trước (bỏ qua tin không có ngày hợp lệ).
          const prevDay = days.slice(0, i).reverse().find(Boolean) ?? ""
          const sep = day && day !== prevDay
          const out = m.direction === "out"
          const time = formatTimeVn(m.at)
          return (
            <div key={m.id}>
              {sep && (
                <div className="my-2 flex justify-center">
                  <span className="rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-0.5 text-sm text-muted-foreground">
                    {inboxDayLabel(day, today)}
                  </span>
                </div>
              )}
              <div className={cn("flex flex-col", out ? "items-end" : "items-start")}>
                <div
                  className={cn(
                    "max-w-[min(80%,34rem)] whitespace-pre-wrap break-words rounded-xl px-3.5 py-2.5 text-sm leading-relaxed",
                    out
                      ? "bg-[var(--foreground)] text-[var(--background)]"
                      : "border border-[var(--border)] bg-[var(--card)] text-foreground",
                    m.failed !== undefined && m.failed !== null && "opacity-60",
                  )}
                >
                  {m.text}
                </div>
                <p className="mt-1 px-1 text-sm text-muted-foreground">
                  {m.who ? `${m.who} · ${time}` : time}
                  {m.failed !== undefined && m.failed !== null && (
                    <span className="text-[var(--color-app-tag-red-ink)]"> · Lỗi{m.failed ? `: ${m.failed}` : ""}</span>
                  )}
                </p>
              </div>
            </div>
          )
        })}
      </div>
      <div ref={endRef} />
    </div>
  )
}

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
    <div className="border-t border-[var(--border)] bg-[var(--card)] p-3">
      {notice}
      {offline && <p role="status" className="mb-2 text-sm text-[var(--color-app-tag-amber-ink)]">Đang mất mạng — tin chưa gửi được. Nội dung vẫn giữ trong ô, có mạng lại thì bấm Gửi.</p>}
      <div className="flex items-end gap-2">
        <Textarea
          rows={1}
          aria-label={ariaLabel}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          className="max-h-40 min-h-10 resize-none text-sm"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!disabled && !offline && value.trim() && !pending) onSend()
            }
          }}
        />
        <Button
          variant="outline"
          size="icon"
          className="size-10 shrink-0 max-sm:size-11"
          disabled={disabled || offline || !value.trim() || pending}
          onClick={onSend}
          aria-label="Gửi"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
    </div>
  )
}

/** Khối thông tin ở cột phải: tiêu đề nhỏ + các dòng nhãn/giá trị. */
export function SideSection({ title, rows, children }: { title: string; rows?: { label: string; value: ReactNode }[]; children?: ReactNode }) {
  return (
    <section className="border-b border-[var(--border)] px-4 py-4 last:border-b-0">
      <h3 className="mb-2.5 text-sm font-medium text-muted-foreground">{title}</h3>
      {rows && rows.length > 0 && (
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="min-w-0 break-words text-foreground">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </section>
  )
}

/** Trạng thái trống trong một cột: icon trong ô tròn, tiêu đề (tuỳ chọn) + lời giải thích. */
export function InboxEmpty({ icon, title, children }: { icon?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      {icon ? (
        <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5 [&_svg]:opacity-100">{icon}</span>
      ) : null}
      <div className="flex max-w-xs flex-col gap-1">
        {title ? <p className="text-sm font-medium text-foreground">{title}</p> : null}
        <p className="text-[13px] leading-5 text-muted-foreground">{children}</p>
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
      "h-7 flex-1 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 ease-out outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 max-sm:h-10",
      on ? "bg-[var(--card)] text-foreground shadow-[var(--shadow-field)]" : "text-muted-foreground hover:text-foreground",
    )
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--border)] p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Tìm theo tên hoặc SĐT" aria-label="Tìm hội thoại" value={q} onChange={(e) => onQ(e.target.value)} />
      </div>
      {awaiting ? (
        <div className="flex gap-0.5 rounded-lg bg-muted p-0.5" role="group" aria-label="Lọc hội thoại">
          <button type="button" aria-pressed={!awaiting.on} onClick={() => awaiting.onChange(false)} className={seg(!awaiting.on)}>Tất cả</button>
          <button type="button" aria-pressed={awaiting.on} onClick={() => awaiting.onChange(true)} className={seg(awaiting.on)} data-testid="inbox-awaiting">
            Chưa trả lời{awaiting.count > 0 ? ` (${awaiting.count})` : ""}
          </button>
        </div>
      ) : null}
    </div>
  )
}
