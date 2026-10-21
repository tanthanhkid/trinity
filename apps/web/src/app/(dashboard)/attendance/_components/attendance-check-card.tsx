"use client"

import { useState } from "react"
import { LogIn, LogOut, MapPin } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { errorMessage } from "@/lib/error-messages"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { useIsPhone } from "@/hooks/use-is-phone"
import {
  useCheckIn,
  useCheckOut,
  useTodaySummary,
  type CheckResult,
  type TodaySummarySelf,
} from "@/hooks/use-attendance"
import { formatDateTimeVn } from "@/lib/format"
import { SelfieCaptureDialog } from "./selfie-capture-dialog"

/** Câu lỗi tiếng Việt qua bảng thông điệp chung — không in chữ tiếng Anh của axios ("Request failed…"). */
function extractMessage(err: unknown, fallback: string): string {
  return errorMessage(err, fallback)
}

/**
 * `hideActionBar` (chỉ <640px): tab "Tạo đơn" có thanh đáy riêng cho "Gửi đơn" —
 * chỉ 1 thanh dính đáy tại 1 thời điểm, nên ở tab đó cặp nút Vào/Ra quay về
 * dạng hàng ngang trong thẻ (full-width, 44px) thay vì thanh đáy.
 */
export function AttendanceCheckCard({ hideActionBar = false }: { hideActionBar?: boolean }) {
  const today = useTodaySummary()
  const checkIn = useCheckIn()
  const checkOut = useCheckOut()
  // null = đóng; 'in'/'out' = đang mở dialog chụp selfie cho hành động tương ứng.
  const [captureMode, setCaptureMode] = useState<"in" | "out" | null>(null)

  // today có thể là dạng admin (không có `record`) hoặc self (có `record`).
  const selfRecord =
    today.data && "record" in today.data
      ? (today.data as TodaySummarySelf).record
      : undefined
  const checkedIn = !!selfRecord?.check_in_at
  const checkedOut = !!selfRecord?.check_out_at

  function onResult(res: CheckResult, action: "vào" | "ra") {
    if (res.already) {
      toast.info(`Bạn đã chấm công ${action} hôm nay rồi.`)
    } else {
      toast.success(`Chấm công ${action} thành công tại văn phòng "${res.office}".`)
    }
  }

  /** Sau khi chụp ảnh trong dialog → gửi chấm công kèm selfie. */
  function handleCapture(selfie: Blob) {
    const mode = captureMode
    if (!mode) return
    const action = mode === "in" ? "vào" : "ra"
    const mutation = mode === "in" ? checkIn : checkOut
    mutation.mutate(selfie, {
      onSuccess: (res) => {
        onResult(res, action)
        setCaptureMode(null)
      },
      onError: (err) => {
        toast.error(extractMessage(err, `Chấm công ${action} thất bại.`))
        setCaptureMode(null)
      },
    })
  }

  // Tab "Tạo đơn" trên điện thoại đã có "Gửi đơn" đặc ở thanh đáy →
  // cặp nút chấm công nằm trong thẻ hạ xuống outline (mỗi màn ≤1 nút đặc).
  const isPhone = useIsPhone()
  const demote = hideActionBar && isPhone
  const actionButtons = (
    <>
      <Button
        variant={demote || (checkedIn && !checkedOut) ? "outline" : "default"}
        onClick={() => setCaptureMode("in")}
        disabled={checkIn.isPending || checkedIn}
      >
        <LogIn className="mr-2 h-4 w-4" /> Chấm công vào
      </Button>
      <Button
        variant={!demote && checkedIn && !checkedOut ? "default" : "outline"}
        onClick={() => setCaptureMode("out")}
        disabled={checkOut.isPending || (!!selfRecord && (!checkedIn || checkedOut))}
      >
        <LogOut className="mr-2 h-4 w-4" /> Chấm công ra
      </Button>
    </>
  )

  return (
    <div className="rounded-[var(--radius)] border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Chấm công hôm nay</h2>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" /> Chấm công khi đang trong mạng nội bộ văn
            phòng (đúng IP) trên thiết bị đã đăng ký. Cần chụp ảnh selfie khi vào/ra.
          </p>
        </div>
      </div>

      {selfRecord && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div
            className={`rounded-xl p-3 ${
              checkedIn ? "border border-emerald-200 bg-emerald-50" : "bg-muted/40"
            }`}
          >
            <div className="text-xs text-muted-foreground">Giờ vào</div>
            <div className="font-medium">
              {selfRecord.check_in_at ? formatDateTimeVn(selfRecord.check_in_at) : "—"}
            </div>
          </div>
          <div
            className={`rounded-xl p-3 ${
              checkedOut
                ? "border border-emerald-200 bg-emerald-50"
                : checkedIn
                  ? "border border-amber-200 bg-amber-50"
                  : "bg-muted/40"
            }`}
          >
            <div className="text-xs text-muted-foreground">Giờ ra</div>
            <div className="font-medium">
              {selfRecord.check_out_at ? formatDateTimeVn(selfRecord.check_out_at) : "—"}
            </div>
          </div>
        </div>
      )}

      {/* Ngoại lệ có chủ đích: nút chính nằm trong hero card này, không ở
          góc phải PageHeader. Tại mỗi thời điểm chỉ MỘT nút đặc (việc kế tiếp):
          chưa vào → "vào"; đã vào chưa ra → "ra". Nút đặc bị disable vẫn giữ
          `default`. */}
      <div
        className={`mt-4 flex flex-wrap gap-3 max-sm:grid max-sm:grid-cols-2 max-sm:gap-2 ${
          hideActionBar ? "" : "max-sm:hidden"
        }`}
      >
        {actionButtons}
      </div>
      {/* <640px — cặp nút dính đáy (ngón cái với tới). Spacer của
          thanh bị ẩn vì `main` đã chừa đáy (pb-28) — tránh khoảng trống giữa thẻ. */}
      {!hideActionBar && (
        <div className="sm:hidden [&_[data-slot=mobile-action-bar-spacer]]:hidden">
          <MobileActionBar className="[&>*]:flex-1">{actionButtons}</MobileActionBar>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Nếu báo sai thiết bị (vd đổi máy/trình duyệt), liên hệ quản trị viên để đặt lại
        thiết bị.
      </p>

      <SelfieCaptureDialog
        open={captureMode !== null}
        title={captureMode === "out" ? "Chụp ảnh chấm công ra" : "Chụp ảnh chấm công vào"}
        pending={checkIn.isPending || checkOut.isPending}
        onClose={() => setCaptureMode(null)}
        onCapture={handleCapture}
      />
    </div>
  )
}
