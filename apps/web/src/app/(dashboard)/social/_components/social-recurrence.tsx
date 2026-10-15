"use client"

import { useState } from "react"
import { CalendarClock, Loader2, Pause, Play, Repeat, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { getApiErrorMessage } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { useRecurrenceMutations, useSocialAccounts, useSocialRecurrences, type SocialRecurrence } from "@/hooks/use-social"
import { queueWhenLabel } from "./social-queue"
import { RECURRENCE_WEEKDAYS, nextTimesLine, recurrenceError, ruleText, type RecurrenceForm } from "./social-recurrence-rules"

const FREQ_LABEL: Record<RecurrenceForm["freq"], string> = { daily: "Hằng ngày", weekly: "Hằng tuần — chọn thứ", monthly: "Hằng tháng — chọn ngày" }
const UNIT: Record<RecurrenceForm["freq"], string> = { daily: "ngày", weekly: "tuần", monthly: "tháng" }

/** Các ô của lựa chọn "Lặp lại" trong ô soạn (giờ Việt Nam). */
export function RecurrenceFields({ value, onChange }: { value: RecurrenceForm; onChange: (v: RecurrenceForm) => void }) {
  const set = (p: Partial<RecurrenceForm>) => onChange({ ...value, ...p })
  const err = recurrenceError(value)
  const toggleDay = (w: number) => set({ weekdays: value.weekdays.includes(w) ? value.weekdays.filter((x) => x !== w) : [...value.weekdays, w] })
  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-3 text-sm" data-testid="recurrence-fields">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={value.freq}
          onChange={(e) => set({ freq: e.target.value as RecurrenceForm["freq"] })}
          aria-label="Tần suất"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          {(Object.keys(FREQ_LABEL) as Array<RecurrenceForm["freq"]>).map((f) => <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
        </select>
        <span className="flex items-center gap-1.5">
          mỗi
          <Input type="number" min={1} max={12} value={value.interval} onChange={(e) => set({ interval: Number(e.target.value) })} aria-label="Khoảng lặp" className="h-9 w-16" />
          {UNIT[value.freq]}
        </span>
        <span className="flex items-center gap-1.5">
          lúc
          <Input type="time" value={value.time} onChange={(e) => set({ time: e.target.value })} aria-label="Giờ đăng" className="h-9 w-28" />
          <span className="text-xs text-muted-foreground">giờ Việt Nam</span>
        </span>
      </div>
      {value.freq === "weekly" && (
        <div role="group" aria-label="Các thứ đăng" className="flex flex-wrap gap-1.5">
          {RECURRENCE_WEEKDAYS.map((d) => {
            const on = value.weekdays.includes(d.weekday)
            return (
              <button
                key={d.weekday}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(d.weekday)}
                className={cn("h-8 min-w-10 rounded-md border px-2 text-xs font-medium transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}
              >
                {d.label}
              </button>
            )
          })}
        </div>
      )}
      {value.freq === "monthly" && (
        <span className="flex items-center gap-1.5">
          vào ngày
          <Input type="number" min={1} max={31} value={value.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })} aria-label="Ngày trong tháng" className="h-9 w-16" />
          <span className="text-xs text-muted-foreground">tháng ngắn hơn thì đăng vào ngày cuối tháng</span>
        </span>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5">
          Bắt đầu
          <Input type="date" value={value.startsOn} onChange={(e) => set({ startsOn: e.target.value })} aria-label="Ngày bắt đầu" className="h-9 w-auto" />
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          Kết thúc
          <select value={value.endMode} onChange={(e) => set({ endMode: e.target.value as RecurrenceForm["endMode"] })} aria-label="Cách kết thúc" className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option value="never">Không kết thúc</option>
            <option value="date">Đến ngày</option>
            <option value="count">Sau N lần</option>
          </select>
          {value.endMode === "date" && <Input type="date" value={value.endsOn} min={value.startsOn} onChange={(e) => set({ endsOn: e.target.value })} aria-label="Ngày kết thúc" className="h-9 w-auto" />}
          {value.endMode === "count" && (
            <span className="flex items-center gap-1.5">
              <Input type="number" min={1} max={1000} value={value.maxCount} onChange={(e) => set({ maxCount: Number(e.target.value) })} aria-label="Số lần đăng" className="h-9 w-20" />
              lần
            </span>
          )}
        </span>
      </div>
      {err ? <p className="text-xs text-destructive" data-testid="recurrence-error">{err}</p> : <p className="text-xs text-muted-foreground" data-testid="recurrence-next">{nextTimesLine(value)}</p>}
      <p className="text-xs text-muted-foreground">Trinity luôn giữ đúng một bài hẹn giờ sắp tới. Máy chủ tắt quá 1 giờ thì bỏ lần lỡ, không đăng muộn. Sửa hoặc tạm dừng ở tab Lịch.</p>
    </div>
  )
}

function Row({ r, names }: { r: SocialRecurrence; names: Map<number, string> }) {
  const { pause, resume, remove } = useRecurrenceMutations()
  const busy = pause.isPending || resume.isPending || remove.isPending
  const finished = r.active && !r.next_run_at && r.next_times.length === 0
  const channels = r.template.targets.map((t) => names.get(t.account_id) ?? `#${t.account_id}`).join(", ")
  const run = (m: typeof pause | typeof resume, ok: string) => m.mutate(r.id, { onSuccess: () => toast.success(ok), onError: (e) => toast.error(getApiErrorMessage(e, "Không thực hiện được")) })
  const [confirmDel, setConfirmDel] = useState(false)
  const del = () =>
    remove.mutate(r.id, {
      onSuccess: () => {
        setConfirmDel(false)
        toast.success("Đã xoá lịch lặp.")
      },
      onError: (e) => toast.error(getApiErrorMessage(e, "Không xoá được")),
    })
  return (
    <li className="space-y-1.5 py-3" data-testid="recurrence-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{r.title}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-xs", r.active ? (finished ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400") : "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
          {!r.active ? "Tạm dừng" : finished ? "Đã kết thúc" : "Đang chạy"}
        </span>
        {r.active ? (
          <Button type="button" size="sm" variant="outline" disabled={busy || finished} onClick={() => run(pause, "Đã tạm dừng.")}><Pause className="size-3.5" /> Tạm dừng</Button>
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(resume, "Đã tiếp tục.")}><Play className="size-3.5" /> Tiếp tục</Button>
        )}
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDel(true)} aria-label={`Xoá ${r.title}`}>
          {remove.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Xoá
        </Button>
        <ConfirmDialog
          open={confirmDel}
          onOpenChange={setConfirmDel}
          title={`Xoá lịch lặp "${r.title}"?`}
          description="Bài hẹn đang chờ của lịch này sẽ bị huỷ; bài đã đăng giữ nguyên."
          confirmLabel="Xoá lịch lặp"
          pending={remove.isPending}
          onConfirm={del}
        />
      </div>
      <p className="text-xs text-muted-foreground">{ruleText(r.rule)} · {channels || "chưa có kênh"} · đã tạo {r.count}{r.max_count ? `/${r.max_count}` : ""} bài{r.ends_on ? ` · đến hết ${r.ends_on}` : ""}</p>
      {r.template.content.trim() && <p className="line-clamp-2 text-sm">{r.template.content}</p>}
      {r.last_error && <p className="text-xs text-destructive" data-testid="recurrence-last-error">{r.last_error}</p>}
      {r.active && r.next_times.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-testid="recurrence-times">
          <CalendarClock className="size-3.5" /> Lần tới:
          {r.next_times.map((t) => <span key={t} className="font-mono">{queueWhenLabel(t)}</span>)}
        </p>
      )}
    </li>
  )
}

/** Mục "Bài lặp lại" ở tab Lịch: danh sách lịch lặp, tạm dừng / tiếp tục / xoá, lần đăng tới, lỗi (đỏ). */
export function SocialRecurrenceList() {
  const q = useSocialRecurrences()
  const accounts = useSocialAccounts()
  const names = new Map((accounts.data ?? []).map((a) => [a.id, a.name]))
  const rows = q.data ?? []
  return (
    <section className="space-y-2 rounded-xl border border-border p-4" aria-label="Bài lặp lại">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Repeat className="size-4" /> Bài lặp lại</h3>
      {q.isLoading ? (
        <Loader2 className="size-4 animate-spin" aria-label="Đang tải" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="recurrence-empty">Chưa có bài lặp lại. Ở tab Soạn bài, chọn “Lặp lại” để đăng một bài đều đặn hằng ngày, tuần hoặc tháng.</p>
      ) : (
        <ul className="divide-y divide-border">{rows.map((r) => <Row key={r.id} r={r} names={names} />)}</ul>
      )}
    </section>
  )
}
