"use client"

import { useState } from "react"
import { ListChecks, Loader2, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { getApiErrorMessage } from "@/lib/api-client"
import { useQueueSlots, useSocialMutations, type QueueSlot } from "@/hooks/use-social"

/** Thứ tự hiện trong lưới: T2 đầu tuần, Chủ nhật cuối (weekday 0). */
export const QUEUE_WEEKDAYS: ReadonlyArray<{ weekday: number; label: string }> = [
  { weekday: 1, label: "Thứ Hai" }, { weekday: 2, label: "Thứ Ba" }, { weekday: 3, label: "Thứ Tư" }, { weekday: 4, label: "Thứ Năm" },
  { weekday: 5, label: "Thứ Sáu" }, { weekday: 6, label: "Thứ Bảy" }, { weekday: 0, label: "Chủ nhật" },
]
const MAX_SLOTS = 100
const pad = (n: number) => String(n).padStart(2, "0")

/** Số phút → "HH:mm". */
export const minuteText = (minute: number): string => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`

/** "HH:mm" (ô `type=time`) → số phút; null khi sai dạng. */
export function parseMinute(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  return h > 23 || mm > 59 ? null : h * 60 + mm
}

/** Thêm một khung: bỏ trùng, giữ thứ tự thứ rồi giờ. */
export function addSlot(list: QueueSlot[], slot: QueueSlot): QueueSlot[] {
  if (list.some((s) => s.weekday === slot.weekday && s.minute === slot.minute)) return list
  return sortSlots([...list, slot])
}

export const removeSlot = (list: QueueSlot[], slot: QueueSlot): QueueSlot[] => list.filter((s) => !(s.weekday === slot.weekday && s.minute === slot.minute))

export const sortSlots = (list: QueueSlot[]): QueueSlot[] => [...list].sort((a, b) => a.weekday - b.weekday || a.minute - b.minute)

const WEEKDAY_NAME = Object.fromEntries(QUEUE_WEEKDAYS.map((d) => [d.weekday, d.label])) as Record<number, string>

/** ISO → "09:00 Thứ Ba 20/10" theo giờ Việt Nam (UTC+7, không có giờ mùa hè), không phụ thuộc múi giờ máy. */
export function queueWhenLabel(iso: string): string {
  const vn = new Date(Date.parse(iso) + 7 * 3_600_000)
  return `${pad(vn.getUTCHours())}:${pad(vn.getUTCMinutes())} ${WEEKDAY_NAME[vn.getUTCDay()]} ${pad(vn.getUTCDate())}/${pad(vn.getUTCMonth() + 1)}`
}

function WeekdayRow({ label, times, onAdd, onRemove }: { label: string; times: number[]; onAdd: (minute: number) => void; onRemove: (minute: number) => void }) {
  const [value, setValue] = useState("09:00")
  const minute = parseMinute(value)
  return (
    <li className="flex flex-wrap items-center gap-2 py-2" data-testid="queue-weekday">
      <span className="w-20 shrink-0 text-sm font-medium">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {times.length === 0 && <span className="text-xs text-muted-foreground">Không đăng</span>}
        {times.map((m) => (
          <span key={m} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-xs">
            {minuteText(m)}
            <button type="button" aria-label={`Bỏ ${minuteText(m)} ${label}`} className="text-muted-foreground hover:text-foreground" onClick={() => onRemove(m)}>
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <Input type="time" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Giờ thêm cho ${label}`} className="h-8 w-28" />
        <Button type="button" size="sm" variant="outline" disabled={minute === null} aria-label={`Thêm giờ ${label}`} onClick={() => minute !== null && onAdd(minute)}>
          <Plus className="size-3.5" /> Thêm
        </Button>
      </div>
    </li>
  )
}

/** Hộp thoại sửa khung giờ hàng đợi hằng tuần (giờ Việt Nam). Lưu = thay toàn bộ danh sách. */
export function SocialQueueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = useQueueSlots()
  const { setQueueSlots } = useSocialMutations()
  // Bản đang sửa; null = chưa sửa gì (hiện đúng dữ liệu máy chủ). Đóng hộp thoại thì bỏ bản sửa.
  const [edit, setEdit] = useState<QueueSlot[] | null>(null)
  const slots = edit ?? sortSlots(q.data ?? [])
  const setSlots = (f: (l: QueueSlot[]) => QueueSlot[]) => setEdit(f(slots))
  const close = (v: boolean) => {
    if (!v) setEdit(null)
    onOpenChange(v)
  }

  const save = () =>
    setQueueSlots.mutate(slots, {
      onSuccess: () => {
        toast.success(slots.length ? `Đã lưu ${slots.length} khung giờ.` : "Đã xoá hết khung giờ.")
        close(false)
      },
      onError: (e) => toast.error(getApiErrorMessage(e, "Không lưu được khung giờ")),
    })

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Khung giờ hàng đợi</DialogTitle>
          <DialogDescription>Hàng đợi đăng bài vào khung trống gần nhất trong tuần. Giờ theo giờ Việt Nam (UTC+7).</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <Loader2 className="size-4 animate-spin" aria-label="Đang tải" />
        ) : (
          <>
            {slots.length === 0 && <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground" data-testid="queue-empty">Chưa có khung giờ. Thêm các giờ đăng cố định mỗi tuần (vd T2–T6 lúc 09:00 và 19:30); bấm “Vào hàng đợi” khi soạn bài, bài sẽ tự hẹn vào khung trống kế tiếp.</p>}
            <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto pr-1">
              {QUEUE_WEEKDAYS.map((d) => (
                <WeekdayRow
                  key={d.weekday}
                  label={d.label}
                  times={slots.filter((s) => s.weekday === d.weekday).map((s) => s.minute)}
                  onAdd={(minute) => setSlots((l) => (l.length >= MAX_SLOTS ? (toast.error(`Tối đa ${MAX_SLOTS} khung giờ.`), l) : addSlot(l, { weekday: d.weekday, minute })))}
                  onRemove={(minute) => setSlots((l) => removeSlot(l, { weekday: d.weekday, minute }))}
                />
              ))}
            </ul>
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>Đóng</Button>
          <Button type="button" onClick={save} disabled={q.isLoading || setQueueSlots.isPending}>
            {setQueueSlots.isPending && <Loader2 className="size-4 animate-spin" />} Lưu khung giờ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Nút mở hộp thoại khung giờ (đặt ở đầu tab Lịch), kèm tóm tắt số khung. */
export function SocialQueueButton() {
  const [open, setOpen] = useState(false)
  const q = useQueueSlots()
  const n = q.data?.length ?? 0
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ListChecks className="size-4" /> Khung giờ hàng đợi{q.data ? ` (${n})` : ""}
      </Button>
      <SocialQueueDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
