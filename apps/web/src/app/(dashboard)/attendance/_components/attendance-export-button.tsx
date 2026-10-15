"use client"

import { useState } from "react"
import { Download, FileDown } from "lucide-react"
import { toast } from "sonner"
import apiClient from "@/lib/api-client"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface Preset {
  key: string
  label: string
  from: string // YYYY-MM-DD
  to: string // YYYY-MM-DD
}

const pad = (n: number) => String(n).padStart(2, "0")
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/** Ngày hiện tại theo múi giờ VN + thứ trong tuần (0=CN..6=T7) — tính trên lịch UTC để khỏi lệch tz. */
function vnToday(): { y: number; m: number; d: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
  const [y, m, d] = parts.split("-").map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return { y, m, d, dow }
}

/** Cộng/trừ ngày trên lịch (UTC, tránh DST drift) → YYYY-MM-DD */
function addDays(y: number, m: number, d: number, delta: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d + delta))
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function buildPresets(): Preset[] {
  const { y, m, d, dow } = vnToday()
  const today = ymd(y, m, d)
  const mondayDelta = (dow + 6) % 7 // 0 nếu là Thứ 2
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return [
    { key: "today", label: "Hôm nay", from: today, to: today },
    { key: "yesterday", label: "Hôm qua", from: addDays(y, m, d, -1), to: addDays(y, m, d, -1) },
    { key: "2days", label: "2 ngày trước", from: addDays(y, m, d, -2), to: addDays(y, m, d, -2) },
    { key: "thisweek", label: "Tuần này", from: addDays(y, m, d, -mondayDelta), to: today },
    { key: "thismonth", label: "Tháng này", from: ymd(y, m, 1), to: today },
    { key: "lastmonth", label: "Tháng trước", from: ymd(py, pm, 1), to: ymd(py, pm, lastDayOfMonth(py, pm)) },
  ]
}

/** DD/MM/YYYY hiển thị từ YYYY-MM-DD */
function display(ds: string): string {
  const [yy, mm, dd] = ds.split("-")
  return `${dd}/${mm}/${yy}`
}

/**
 * `hideTrigger` + `open`/`onOpenChange` (điện thoại): nút "Xuất Excel" nằm trong menu "⋯"
 * của header → trang tự điều khiển việc mở dialog; không truyền gì = hành vi cũ (nút + dialog).
 */
export function AttendanceExportButton({
  hideTrigger = false,
  open: controlledOpen,
  onOpenChange,
}: {
  hideTrigger?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
} = {}) {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = controlledOpen ?? innerOpen
  const setOpen = (o: boolean) => {
    setInnerOpen(o)
    onOpenChange?.(o)
  }
  const [busy, setBusy] = useState<string | null>(null)
  const presets = buildPresets()

  async function handleExport(p: Preset) {
    setBusy(p.key)
    try {
      const res = await apiClient.get<Blob>("/management/attendance/export", {
        params: { date_from: p.from, date_to: p.to },
        responseType: "blob",
      })
      const blob = res.data
      if (!blob || blob.size === 0) throw new Error("empty")
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `cham-cong_${p.key}_${p.from}_${p.to}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      toast.success(`Đã xuất Excel chấm công: ${p.label}`)
      setOpen(false)
    } catch {
      toast.error("Xuất Excel thất bại. Vui lòng thử lại.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {!hideTrigger && (
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setOpen(true)}
        >
          <Download className="size-4" />
          Xuất Excel
        </Button>
      )}

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Xuất Excel chấm công</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Chọn khoảng thời gian để tải file Excel (tất cả nhân viên).
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {presets.map((p) => (
              <Button
                key={p.key}
                type="button"
                variant="outline"
                className="h-auto flex-col items-start gap-0.5 py-2.5"
                disabled={busy !== null}
                onClick={() => handleExport(p)}
              >
                <span className="flex items-center gap-1.5 font-semibold">
                  <FileDown className="size-3.5" />
                  {p.label}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {p.from === p.to
                    ? display(p.from)
                    : `${display(p.from)} – ${display(p.to)}`}
                  {busy === p.key ? " · Đang tải…" : ""}
                </span>
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
