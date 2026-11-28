"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { HeroCard } from "@/components/ui/hero-card"
import { errorMessage } from "@/lib/error-messages"
import { formatTimeVn } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  useCheckIn,
  useCheckOut,
  type AttendanceRecord,
  type CheckResult,
} from "@/hooks/use-attendance"
import { toast } from "sonner"
import { SelfieCaptureDialog } from "./selfie-capture-dialog"

/** Giờ hiện tại HH:MM theo giờ Việt Nam, cập nhật mỗi 10 giây. */
function useClock(): string {
  const [now, setNow] = useState(() => formatTimeVn(new Date()))
  useEffect(() => {
    const id = setInterval(() => setNow(formatTimeVn(new Date())), 10_000)
    return () => clearInterval(id)
  }, [])
  return now
}

/** Pha trong ngày: 0 chưa vào ca, 1 đang trong ca, 2 đã đủ công. */
export function dayPhase(record: Pick<AttendanceRecord, "check_in_at" | "check_out_at"> | null | undefined): 0 | 1 | 2 {
  if (record?.check_out_at) return 2
  if (record?.check_in_at) return 1
  return 0
}

export const PHASE_HEADLINE = ["Chưa vào ca", "Đang trong ca", "Hết ca hôm nay"] as const

/**
 * Khối nhấn của màn chấm công nhân viên (thiết kế chamcong-mobile): đồng hồ lớn, chip trạng thái,
 * MỘT nút chính theo pha (vào → ra → đã đủ công) mở khay chụp selfie. Điều kiện IP văn phòng +
 * thiết bị đã đăng ký do máy chủ kiểm khi chấm; lỗi trả về hiện ngay trên khối (chip đỏ + lời giải thích).
 */
export function AttendanceCheckCard({
  record,
  loading,
}: {
  /** Bản ghi chấm công hôm nay của CHÍNH mình (null = chưa có). */
  record: AttendanceRecord | null
  loading: boolean
}) {
  const checkIn = useCheckIn()
  const checkOut = useCheckOut()
  const clock = useClock()
  // null = đóng; 'in'/'out' = đang mở khay chụp selfie cho hành động tương ứng.
  const [captureMode, setCaptureMode] = useState<"in" | "out" | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const phase = dayPhase(record)
  const pending = checkIn.isPending || checkOut.isPending
  const disabled = loading || pending || phase === 2 || !!failure
  const label = failure
    ? "Chưa chấm được"
    : phase === 0
      ? "Chấm công vào"
      : phase === 1
        ? "Chấm công ra"
        : "Đã đủ công hôm nay"

  function onResult(res: CheckResult, action: "vào" | "ra") {
    if (res.already) {
      toast.info(`Bạn đã chấm công ${action} hôm nay rồi.`)
    } else {
      // office null: máy chủ chưa xác định được IP (lỗi cấu hình, đã cảnh báo quản trị) — vẫn ghi nhận chấm công.
      toast.success(res.office ? `Chấm công ${action} thành công tại văn phòng "${res.office}".` : `Chấm công ${action} thành công.`)
    }
  }

  /** Sau khi chụp ảnh trong khay → gửi chấm công kèm selfie. */
  function handleCapture(selfie: Blob) {
    const mode = captureMode
    if (!mode) return
    const action = mode === "in" ? "vào" : "ra"
    const mutation = mode === "in" ? checkIn : checkOut
    setFailure(null)
    mutation.mutate(selfie, {
      onSuccess: (res) => {
        onResult(res, action)
        setCaptureMode(null)
      },
      onError: (err) => {
        const msg = errorMessage(err, `Chấm công ${action} thất bại.`)
        toast.error(msg)
        setFailure(msg)
        setCaptureMode(null)
      },
    })
  }

  return (
    <HeroCard className="p-4 pt-6 text-center max-sm:p-4 max-sm:pt-6 sm:rounded-[var(--ax-radius-hero)]" aria-label="Chấm công hôm nay">
      <h2 className="sr-only">Chấm công hôm nay</h2>
      <div
        data-slot="attendance-clock"
        className="ax-amount text-[68px] leading-none font-bold tracking-[-0.03em] text-white"
        aria-label={`Bây giờ là ${clock}`}
      >
        {clock}
      </div>
      <div
        role={failure ? "alert" : undefined}
        className={cn(
          "mt-3.5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold shadow-[0_6px_14px_-8px_rgba(13,32,54,.6)]",
          failure
            ? "bg-ax-danger-soft text-[var(--ax-danger-ink)]"
            : "bg-ax-success-soft text-ax-success",
        )}
      >
        <span aria-hidden className="size-2 rounded-full bg-current" />
        {failure
          ? "Chưa chấm công được"
          : phase === 2
            ? `Đã chấm ra lúc ${formatTimeVn(record?.check_out_at)}`
            : phase === 1
              ? `Đã chấm vào lúc ${formatTimeVn(record?.check_in_at)}`
              : "Sẵn sàng chấm công"}
      </div>
      <p className="mx-2 mt-3 text-sm leading-[1.45] text-[var(--ax-on-hero-ink-2)]">
        {failure ??
          "Chấm công khi đang ở mạng văn phòng, trên thiết bị đã đăng ký. Cần chụp ảnh selfie khi vào/ra."}
      </p>
      {failure && (
        <Button
          variant="ax-on-hero-secondary"
          size="ax"
          className="mt-3"
          onClick={() => setFailure(null)}
        >
          Thử lại
        </Button>
      )}
      <Button
        variant="ax-on-hero"
        className="mt-[18px] h-[60px] w-full rounded-2xl text-lg font-bold tracking-[-0.011em] disabled:bg-white/20 disabled:text-white disabled:opacity-100"
        disabled={disabled}
        onClick={() => setCaptureMode(phase === 0 ? "in" : "out")}
      >
        {label}
      </Button>
      {phase > 0 && (
        <p className="mt-3 text-[13px] text-[var(--ax-on-hero-ink-2)]">
          Chấm nhầm? Tạo đơn bổ sung để quản lý sửa giờ.
        </p>
      )}
      <p className="mt-3 text-[13px] text-[var(--ax-on-hero-ink-2)]">
        Báo sai thiết bị (đổi máy/trình duyệt)? Liên hệ quản trị viên để đặt lại thiết bị.
      </p>

      <SelfieCaptureDialog
        open={captureMode !== null}
        title={captureMode === "out" ? "Chụp ảnh để ra ca" : "Chụp ảnh để vào ca"}
        pending={pending}
        onClose={() => setCaptureMode(null)}
        onCapture={handleCapture}
      />
    </HeroCard>
  )
}
