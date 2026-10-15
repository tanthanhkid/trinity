"use client"

import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { todayVn } from "@/lib/format"
import {
  useWorkingSaturdays,
  useUpdateWorkingSaturdays,
} from "@/hooks/use-attendance"

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * Cấu hình các thứ 7 ĐƯỢC TÍNH đi làm (super_admin + hr).
 * Tick thứ 7 của tháng đang xem → lưu danh sách ngày YYYY-MM-DD lên server.
 * T2–T6 mặc định luôn là ngày làm; CN nghỉ — không cấu hình ở đây.
 */
export function WorkingSaturdaysDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const iso = todayVn()
  const [year, setYear] = useState(Number(iso.slice(0, 4)))
  const [month, setMonth] = useState(Number(iso.slice(5, 7)) - 1) // 0-11
  const { data } = useWorkingSaturdays()
  const update = useUpdateWorkingSaturdays()
  // Tập ngày đang chọn (chỉnh cục bộ trước khi lưu). null = chưa nạp từ server.
  const [localSet, setLocalSet] = useState<Set<string> | null>(null)

  // Nạp từ server 1 lần (bail-out: chỉ set khi đang null) — tránh render storm.
  useEffect(() => {
    if (data && localSet === null) setLocalSet(new Set(data.dates))
  }, [data, localSet])

  const workingSet = localSet ?? new Set(data?.dates ?? [])

  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const saturdays: string[] = []
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month, d).getDay() === 6) {
      saturdays.push(`${year}-${pad2(month + 1)}-${pad2(d)}`)
    }
  }

  function toggle(dateStr: string) {
    setLocalSet((prev) => {
      const next = new Set(prev ?? new Set(data?.dates ?? []))
      if (next.has(dateStr)) next.delete(dateStr)
      else next.add(dateStr)
      return next
    })
  }
  function prevMonth() {
    if (month === 0) {
      setYear((y) => y - 1)
      setMonth(11)
    } else setMonth((m) => m - 1)
  }
  function nextMonth() {
    if (month === 11) {
      setYear((y) => y + 1)
      setMonth(0)
    } else setMonth((m) => m + 1)
  }

  function handleOpenChange(o: boolean) {
    if (!o) setLocalSet(null) // reset để lần mở sau nạp lại từ server
    onOpenChange(o)
  }

  function save() {
    update.mutate([...workingSet], {
      onSuccess: () => {
        toast.success("Đã lưu cấu hình thứ 7 đi làm")
        handleOpenChange(false)
      },
      onError: () => toast.error("Không lưu được cấu hình"),
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cấu hình thứ 7 đi làm</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Chọn các thứ 7 <span className="font-medium text-foreground">được tính đi làm</span>.
          Thứ 2–6 mặc định luôn là ngày làm; Chủ nhật nghỉ.
        </p>
        <div className="flex items-center justify-center gap-2 py-1">
          <Button size="icon" variant="outline" onClick={prevMonth} aria-label="Tháng trước">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-[110px] text-center text-sm font-medium">
            Tháng {month + 1}/{year}
          </span>
          <Button size="icon" variant="outline" onClick={nextMonth} aria-label="Tháng sau">
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="space-y-2">
          {saturdays.map((s) => {
            const [yy, mm, dd] = s.split("-")
            return (
              <label
                key={s}
                className="flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm hover:bg-muted/40 max-sm:min-h-11"
              >
                <span>
                  Thứ 7 · {dd}/{mm}/{yy}
                </span>
                <input
                  type="checkbox"
                  checked={workingSet.has(s)}
                  onChange={() => toggle(s)}
                  className="size-4 accent-emerald-600"
                />
              </label>
            )
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Huỷ
          </Button>
          <Button onClick={save} disabled={update.isPending} className="gap-2">
            {update.isPending && <Loader2 className="size-4 animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
