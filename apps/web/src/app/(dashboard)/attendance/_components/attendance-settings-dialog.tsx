"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  useAttendanceSettings,
  useUpdateAttendanceSettings,
} from "@/hooks/use-attendance"

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function AttendanceSettingsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { data } = useAttendanceSettings()
  const update = useUpdateAttendanceSettings()
  const [workStart, setWorkStart] = useState("08:00")
  const [workEnd, setWorkEnd] = useState("17:00")
  const [lateAfter, setLateAfter] = useState("08:10")
  const [lunchStart, setLunchStart] = useState("12:00")
  const [lunchEnd, setLunchEnd] = useState("13:30")
  const [reviewMaxHours, setReviewMaxHours] = useState(1)
  const [halfDayMinHours, setHalfDayMinHours] = useState(4)
  const [fullDayMinHours, setFullDayMinHours] = useState(8)

  // Nạp giá trị hiện hành khi mở (deps [open, data] — chỉ sync prop→state, không render-storm)
  useEffect(() => {
    if (open && data) {
      setWorkStart(data.work_start)
      setWorkEnd(data.work_end)
      setLateAfter(data.late_after)
      setLunchStart(data.lunch_start)
      setLunchEnd(data.lunch_end)
      setReviewMaxHours(data.review_max_hours)
      setHalfDayMinHours(data.half_day_min_hours)
      setFullDayMinHours(data.full_day_min_hours)
    }
  }, [open, data])

  async function handleSave() {
    if (![workStart, workEnd, lateAfter, lunchStart, lunchEnd].every((t) => HM_RE.test(t))) {
      toast.error("Giờ không hợp lệ (định dạng HH:MM).")
      return
    }
    if (lunchEnd <= lunchStart) {
      toast.error("Giờ kết thúc nghỉ trưa phải sau giờ bắt đầu.")
      return
    }
    if (
      ![reviewMaxHours, halfDayMinHours, fullDayMinHours].every(
        (h) => Number.isFinite(h) && h >= 0 && h <= 24,
      )
    ) {
      toast.error("Ngưỡng giờ công không hợp lệ (0–24 giờ).")
      return
    }
    if (
      !(reviewMaxHours < halfDayMinHours && halfDayMinHours < fullDayMinHours)
    ) {
      toast.error(
        'Ngưỡng phải tăng dần: "Xem xét" < "Chưa đủ nửa ngày" < "Đủ công".',
      )
      return
    }
    try {
      await update.mutateAsync({
        work_start: workStart,
        work_end: workEnd,
        late_after: lateAfter,
        lunch_start: lunchStart,
        lunch_end: lunchEnd,
        review_max_hours: reviewMaxHours,
        half_day_min_hours: halfDayMinHours,
        full_day_min_hours: fullDayMinHours,
      })
      toast.success("Đã lưu cấu hình ca làm việc.")
      onClose()
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response
        ?.data?.message
      toast.error(msg ?? "Lưu cấu hình thất bại.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col max-h-[85svh] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Thiết lập ca làm việc</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-1 space-y-4 pb-2">
          <p className="text-sm text-muted-foreground">
            Áp dụng cho toàn bộ nhân viên khi chấm công.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Giờ vào ca</Label>
              <Input
                className="max-sm:h-11"
                type="time"
                value={workStart}
                onChange={(e) => setWorkStart(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Giờ tan ca</Label>
              <Input
                className="max-sm:h-11"
                type="time"
                value={workEnd}
                onChange={(e) => setWorkEnd(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Đi muộn nếu vào sau</Label>
            <Input
              className="max-sm:h-11"
              type="time"
              value={lateAfter}
              onChange={(e) => setLateAfter(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Ví dụ 08:10 — check-in sau mốc này sẽ bị tính đi muộn.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Bắt đầu nghỉ trưa</Label>
              <Input
                className="max-sm:h-11"
                type="time"
                value={lunchStart}
                onChange={(e) => setLunchStart(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Kết thúc nghỉ trưa</Label>
              <Input
                className="max-sm:h-11"
                type="time"
                value={lunchEnd}
                onChange={(e) => setLunchEnd(e.target.value)}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Khoảng nghỉ trưa trong ca sẽ bị trừ khỏi tổng giờ làm.
          </p>

          <div className="border-t pt-3">
            <p className="mb-2 text-sm font-medium">Ngưỡng trạng thái theo tổng giờ làm</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>Ngưỡng &quot;Xem xét&quot; (giờ)</Label>
                <Input
                  className="max-sm:h-11"
                  type="number"
                  min={0}
                  max={24}
                  step={0.5}
                  value={reviewMaxHours}
                  onChange={(e) => setReviewMaxHours(Number(e.target.value))}
                />
                <p className="text-sm text-muted-foreground">
                  Tổng dưới mức này → &quot;Xem xét&quot; (đỏ). Vd 1 giờ.
                </p>
              </div>
              <div className="space-y-1">
                <Label>&quot;Chưa đủ nửa ngày&quot; từ (giờ)</Label>
                <Input
                  className="max-sm:h-11"
                  type="number"
                  min={0}
                  max={24}
                  step={0.5}
                  value={halfDayMinHours}
                  onChange={(e) => setHalfDayMinHours(Number(e.target.value))}
                />
                <p className="text-sm text-muted-foreground">
                  Dưới mức này → &quot;Chưa đủ nửa ngày&quot; (cam). Vd 4 giờ.
                </p>
              </div>
              <div className="space-y-1">
                <Label>Đủ công từ (giờ)</Label>
                <Input
                  className="max-sm:h-11"
                  type="number"
                  min={0}
                  max={24}
                  step={0.5}
                  value={fullDayMinHours}
                  onChange={(e) => setFullDayMinHours(Number(e.target.value))}
                />
                <p className="text-sm text-muted-foreground">
                  Từ mức này → đủ công. Khoảng giữa → nửa ngày. Vd 8 giờ.
                </p>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter className="sticky bottom-0 bg-background border-t pt-2 pb-[env(safe-area-inset-bottom)] max-sm:pt-4">
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? "Đang lưu..." : "Lưu cấu hình"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
