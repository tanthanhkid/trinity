"use client"

import { useState } from "react"
import { ChevronLeft, ChevronRight, Loader2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ErrorState } from "@/components/ui/error-state"
import { getApiErrorMessage } from "@/lib/api-client"
import {
  addDays, addMonths, dayOf, monthGrid, monthTitle, rangeFilter, timeOf, visibleRange, vnDay, weekDays, WEEKDAY_LABELS, type CalendarMode,
} from "@/lib/custom-objects/calendar"
import { todayVn } from "@/lib/format"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { SocialImportButton } from "./social-import"
import { SocialQueueButton } from "./social-queue"
import { CALENDAR_MAX_POSTS, isPostEditable, movedSchedule, useSocialMutations, useSocialPostsRange, type SocialPost } from "@/hooks/use-social"

const PER_DAY_MONTH = 3

/** Giờ hẹn gợi ý khi bấm "+" ở một ngày: 09:00; hôm nay đã quá 08:00 thì giờ chẵn kế tiếp sau ít nhất 30 phút (giờ máy người dùng). */
export function defaultSlot(day: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  if (day !== today || now.getHours() < 8) return `${day}T09:00`
  const t = new Date(now.getTime() + 30 * 60_000)
  t.setMinutes(0, 0, 0)
  t.setHours(t.getHours() + 1)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:00`
}

/** Màu chấm theo trạng thái bài. */
const DOT: Record<SocialPost["status"], string> = {
  scheduled: "bg-sky-500",
  publishing: "bg-sky-500 animate-pulse",
  published: "bg-emerald-500",
  partial: "bg-amber-500",
  failed: "bg-red-500",
  cancelled: "bg-muted-foreground/40",
}

const STATUS_LABEL: Record<SocialPost["status"], string> = {
  scheduled: "Đã hẹn giờ",
  publishing: "Đang đăng",
  published: "Đã đăng",
  partial: "Đăng một phần",
  failed: "Lỗi",
  cancelled: "Đã huỷ",
}

/** Mốc đặt bài lên lịch: bài hẹn giờ theo giờ hẹn, bài đăng ngay theo giờ tạo (khớp bộ lọc phía BE). */
export const postWhen = (p: Pick<SocialPost, "scheduled_at" | "created_at">): string => p.scheduled_at ?? p.created_at

function Entry({ p, onOpen }: { p: SocialPost; onOpen: (id: number) => void }) {
  const channels = [...new Set(p.targets.map((t) => t.account_name ?? t.network))].join(" · ")
  // Bài còn hẹn giờ (chưa kênh nào đăng) kéo được sang ngày khác — giữ nguyên giờ.
  const movable = isPostEditable(p)
  return (
    <button
      type="button"
      draggable={movable}
      onDragStart={movable ? (e) => { e.dataTransfer.setData("text/x-social-post", String(p.id)); e.dataTransfer.effectAllowed = "move" } : undefined}
      onClick={() => onOpen(p.id)}
      title={`${STATUS_LABEL[p.status]} — ${p.content.slice(0, 200)}`}
      className={cn("block w-full rounded-md border bg-card px-1.5 py-1 text-left text-xs hover:bg-muted", p.status === "cancelled" && "opacity-60", movable && "cursor-grab active:cursor-grabbing")}
      data-testid="social-calendar-entry"
    >
      <span className="flex items-center gap-1">
        <span className={cn("size-2 shrink-0 rounded-full", DOT[p.status])} aria-label={STATUS_LABEL[p.status]} />
        <span className="font-mono text-muted-foreground">{timeOf(postWhen(p), "datetime")}</span>
        <span className="truncate text-muted-foreground">{channels}</span>
      </span>
      <span className={cn("block truncate font-medium", p.status === "cancelled" && "line-through")}>{p.content.trim() || "(chỉ có ảnh/video)"}</span>
    </button>
  )
}

/**
 * Lịch bài đăng: xem tháng/tuần (T2 đầu tuần, giờ Việt Nam). Bấm bài để mở trong "Bài đã đăng"; bấm "+" ở một ngày chưa qua để
 * soạn bài hẹn giờ vào ngày đó (mặc định 09:00); kéo bài còn hẹn giờ sang ngày khác để dời (giữ nguyên giờ).
 */
export function SocialCalendar({ onOpen, onSchedule }: { onOpen: (postId: number) => void; onSchedule: (localDateTime: string) => void }) {
  const today = todayVn()
  const [mode, setMode] = useState<CalendarMode>("month")
  const [anchor, setAnchor] = useState(today)
  const range = rangeFilter("datetime", visibleRange(mode, anchor))
  const q = useSocialPostsRange(range.from, range.to)
  const byDay = new Map<string, SocialPost[]>()
  for (const p of [...(q.data?.data ?? [])].sort((a, b) => postWhen(a).localeCompare(postWhen(b)))) {
    const d = dayOf(postWhen(p), "datetime")
    if (d) byDay.set(d, [...(byDay.get(d) ?? []), p])
  }
  const step = (n: number) => setAnchor((a) => (mode === "week" ? addDays(a, 7 * n) : addMonths(a, n)))
  const { reschedule } = useSocialMutations()
  const [dropDay, setDropDay] = useState<string | null>(null)
  const posts = q.data?.data ?? []
  // Thả bài vào ngày khác: giữ giờ:phút theo giờ VN; BE kiểm lại (còn hẹn giờ, sau bây giờ ≥ 1 phút).
  const drop = (day: string, raw: string) => {
    setDropDay(null)
    const p = posts.find((x) => x.id === Number(raw))
    if (!p?.scheduled_at || dayOf(p.scheduled_at, "datetime") === day) return
    const at = movedSchedule(p.scheduled_at, day)
    if (Date.parse(at) <= Date.now() + 60_000) return void toast.error("Không dời bài về thời điểm đã qua.")
    reschedule.mutate({ id: p.id, at }, {
      onSuccess: () => toast.success(`Đã dời bài #${p.id} sang ${vnDay(day)} ${timeOf(at, "datetime")}`),
      onError: (e) => toast.error(getApiErrorMessage(e, "Không dời được bài")),
    })
  }
  const title = mode === "week" ? `Tuần ${vnDay(weekDays(anchor)[0])} – ${vnDay(weekDays(anchor)[6])}` : monthTitle(anchor)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label={mode === "week" ? "Tuần trước" : "Tháng trước"} onClick={() => step(-1)}><ChevronLeft className="size-4" /></Button>
        <Button variant="outline" onClick={() => setAnchor(today)}>Hôm nay</Button>
        <Button variant="outline" size="icon" aria-label={mode === "week" ? "Tuần sau" : "Tháng sau"} onClick={() => step(1)}><ChevronRight className="size-4" /></Button>
        <h2 className="text-lg font-semibold" data-testid="social-calendar-title">{title}</h2>
        {q.isFetching && <Loader2 className="size-4 animate-spin" aria-label="Đang tải" />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SocialQueueButton />
          <SocialImportButton />
          <div className="flex gap-1" role="group" aria-label="Kiểu xem lịch">
            {(["month", "week"] as const).map((m) => (
              <Button key={m} size="sm" variant={mode === m ? "soft" : "outline"} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "month" ? "Tháng" : "Tuần"}</Button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(["scheduled", "published", "partial", "failed", "cancelled"] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1"><span className={cn("size-2 rounded-full", DOT[s])} />{STATUS_LABEL[s]}</span>
        ))}
      </div>
      {q.isError && <ErrorState compact title="Không tải được lịch bài" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {q.data?.next_cursor && <p className="text-sm text-amber-700">Khoảng này có hơn {CALENDAR_MAX_POSTS} bài — lịch chỉ hiện {CALENDAR_MAX_POSTS} bài mới nhất. Xem theo tuần để thấy đủ.</p>}
      <div className="overflow-x-auto">
        <div className="grid min-w-[42rem] grid-cols-7 gap-px overflow-hidden rounded-2xl border bg-border" data-testid="social-calendar-grid">
          {WEEKDAY_LABELS.map((w) => <div key={w} className="bg-muted px-2 py-1 text-center text-xs font-semibold text-muted-foreground">{w}</div>)}
          {(mode === "week" ? [weekDays(anchor)] : monthGrid(anchor)).flat().map((d) => {
            const items = byDay.get(d) ?? []
            const shown = mode === "week" ? items : items.slice(0, PER_DAY_MONTH)
            const outside = mode === "month" && d.slice(0, 7) !== anchor.slice(0, 7)
            return (
              <div
                key={d}
                className={cn("group space-y-1 bg-background p-1.5", mode === "week" ? "min-h-64" : "min-h-28", outside && "bg-muted/40 text-muted-foreground", dropDay === d && "bg-primary/10 ring-2 ring-inset ring-primary/40")}
                data-testid="social-calendar-day"
                data-day={d}
                onDragOver={d >= today ? (e) => { if (e.dataTransfer.types.includes("text/x-social-post")) { e.preventDefault(); setDropDay(d) } } : undefined}
                onDragLeave={() => setDropDay((x) => (x === d ? null : x))}
                onDrop={d >= today ? (e) => { e.preventDefault(); drop(d, e.dataTransfer.getData("text/x-social-post")) } : undefined}
              >
                <div className="flex items-center justify-between">
                  <span className={cn("text-xs font-semibold", d === today && "inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground")}>{Number(d.slice(8))}</span>
                  {d >= today && (
                    <button
                      type="button"
                      aria-label={`Hẹn bài ngày ${vnDay(d)}`}
                      title="Hẹn bài vào ngày này"
                      className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                      onClick={() => onSchedule(defaultSlot(d))}
                    >
                      <Plus className="size-3.5" />
                    </button>
                  )}
                </div>
                {shown.map((p) => <Entry key={p.id} p={p} onOpen={onOpen} />)}
                {items.length > shown.length && <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setAnchor(d); setMode("week") }}>+{items.length - shown.length} nữa</button>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
