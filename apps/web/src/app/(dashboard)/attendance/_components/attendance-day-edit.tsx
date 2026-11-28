"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { AX_INPUT_CLASS } from "@/components/ui/input"
import { showUndoToast } from "@/components/ui/undo-toast"
import { errorMessage } from "@/lib/error-messages"
import { formatDateTimeVn, formatTimeVn } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  useAdjustAttendance,
  useAttendanceEdits,
  type AdjustAttendanceBody,
  type AttendanceRecord,
} from "@/hooks/use-attendance"

/** Thời gian giữ lần sửa chờ Hoàn tác (ms) — bằng thời gian toast tự ẩn. */
export const ADJUST_UNDO_MS = 5000

interface Held {
  recordId: number
  body: AdjustAttendanceBody
}

/** `H:MM`/`HH:MM` 24 giờ ⇒ `HH:MM`; sai dạng ⇒ null (cùng luật với máy chủ). */
export function normalizeHm(raw: string): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.trim())
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null
}

/**
 * Kiểm form sửa giờ. Trả thân gửi (chỉ giờ đã đổi) hoặc câu lỗi hiện dưới form.
 * `curIn`/`curOut` là giờ hiện tại `HH:MM` ("" = chưa có).
 */
export function buildAdjustBody(
  curIn: string,
  curOut: string,
  inRaw: string,
  outRaw: string,
  reasonRaw: string,
): { body: AdjustAttendanceBody } | { error: string } {
  const ti = inRaw.trim()
  const to = outRaw.trim()
  const nIn = ti === "" ? "" : normalizeHm(ti)
  const nOut = to === "" ? "" : normalizeHm(to)
  if (nIn === null || nOut === null) return { error: "Giờ nhập dạng 24h, ví dụ 08:05." }
  if (nIn && nOut && nOut <= nIn) return { error: "Giờ ra phải sau giờ vào." }
  const body: AdjustAttendanceBody = { reason: reasonRaw.trim() }
  // Ô để trống = giữ nguyên (máy chủ không xoá giờ đã có).
  if (nIn && nIn !== curIn) body.check_in = nIn
  if (nOut && nOut !== curOut) body.check_out = nOut
  if (!body.check_in && !body.check_out) return { error: "Chưa đổi giờ vào hay giờ ra nào." }
  if (!body.reason) return { error: "Nhập lý do sửa để lưu lại lịch sử." }
  if (body.reason.length > 500) return { error: "Lý do tối đa 500 ký tự." }
  return { body }
}

/** «08:25 28/11/2026» từ thời điểm ISO (giờ VN). */
function atText(iso: string): string {
  const [time, date] = formatDateTimeVn(iso).split(" ")
  return time && date ? `${time.slice(0, 5)} ${date}` : formatDateTimeVn(iso)
}

export interface DayAdjust {
  editing: boolean
  setEditing: (v: boolean) => void
  /** Giờ hiển thị (đã áp lần sửa đang chờ Hoàn tác); "" = chưa có. */
  inText: string
  outText: string
  /** Có lần sửa đang giữ 5 giây hoặc đang gửi. */
  busy: boolean
  submit: (body: AdjustAttendanceBody) => void
}

/**
 * Trạng thái «Sửa giờ công» của một bản ghi. Hoàn tác: máy chủ không có API «đảo lần sửa» (và đảo bằng một lần
 * sửa nữa sẽ làm bẩn lịch sử), nên lần sửa được GIỮ 5 giây rồi mới gửi; bấm Hoàn tác trong lúc đó = chưa gửi gì;
 * rời trang hoặc đổi bản ghi trong 5 giây = gửi ngay. Giờ hiển thị đã áp lần sửa tới khi máy chủ trả và dữ liệu tải lại.
 */
export function useDayAdjust(record: AttendanceRecord | null, personName: string): DayAdjust {
  const adjust = useAdjustAttendance()
  const [editing, setEditing] = useState(false)
  const [held, setHeld] = useState<Held | null>(null)
  const heldRef = useRef<Held | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastId = useRef<string | number | undefined>(undefined)
  const mutate = adjust.mutate

  useEffect(() => {
    heldRef.current = held
  }, [held])

  const commit = useCallback(
    (h: Held) => {
      mutate(
        { id: h.recordId, body: h.body },
        {
          onSuccess: () => setHeld((cur) => (cur === h ? null : cur)),
          onError: (err) => {
            toast.error(errorMessage(err, "Chưa sửa được giờ công"))
            setHeld((cur) => (cur === h ? null : cur))
          },
        },
      )
    },
    [mutate],
  )
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  }, [commit])

  // Rời trang khi còn lần sửa chờ Hoàn tác → gửi ngay, không để mất.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        const h = heldRef.current
        if (h) commitRef.current(h)
      }
    },
    [],
  )

  const recordId = record?.id ?? null
  // Đổi sang bản ghi khác: đóng form (lần sửa đang chờ vẫn tiếp tục, gắn với bản ghi cũ).
  useEffect(() => {
    setEditing(false)
  }, [recordId])

  const submit = useCallback(
    (body: AdjustAttendanceBody) => {
      if (recordId == null) return
      const h: Held = { recordId, body }
      setHeld(h)
      setEditing(false)
      toastId.current = showUndoToast(`Đã sửa giờ công của ${personName}`, {
        duration: ADJUST_UNDO_MS,
        onUndo: () => {
          if (!timer.current) {
            toast.info("Lần sửa đã gửi lên máy chủ, không hoàn tác được nữa. Sửa lại bằng một lần sửa mới.")
            return
          }
          clearTimeout(timer.current)
          timer.current = null
          setHeld(null)
        },
      })
      timer.current = setTimeout(() => {
        timer.current = null
        toast.dismiss(toastId.current)
        commit(h)
      }, ADJUST_UNDO_MS)
    },
    [recordId, personName, commit],
  )

  const mine = held && held.recordId === recordId ? held : null
  const inText = mine?.body.check_in ?? (record?.check_in_at ? formatTimeVn(record.check_in_at) : "")
  const outText = mine?.body.check_out ?? (record?.check_out_at ? formatTimeVn(record.check_out_at) : "")
  return { editing, setEditing, inText, outText, busy: held !== null, submit }
}

/** Dưới các hàng «Công ngày»: dòng «Đã sửa tay…» (lần sửa gần nhất) và nút Sửa giờ công. */
export function DayEditControls({
  record,
  adjust,
  allowEdit,
}: {
  record: AttendanceRecord | null
  adjust: DayAdjust
  /** false: ngày nghỉ phép/thai sản hoặc chưa có bản ghi để sửa. */
  allowEdit: boolean
}) {
  const edits = useAttendanceEdits(record?.id ?? null)
  const last = edits.data?.[0]
  return (
    <>
      {last && (
        <p className="mt-2 text-[13px] leading-snug text-ax-ink-2" data-slot="day-edit-note">
          Đã sửa tay lúc {atText(last.created_at)}
          {last.editor_name ? ` bởi ${last.editor_name}` : ""}. Lý do: {last.reason}
          {(edits.data?.length ?? 0) > 1 && ` (${edits.data?.length} lần sửa)`}
        </p>
      )}
      {allowEdit && record && !adjust.editing && (
        <Button
          variant="ax-secondary"
          size="ax"
          className="mt-3"
          disabled={adjust.busy}
          onClick={() => adjust.setEditing(true)}
        >
          Sửa giờ công
        </Button>
      )}
    </>
  )
}

/** Khung sửa giờ + lý do bắt buộc, mở dưới hai thẻ «Công ngày» / «Hạn mức». */
export function DayEditPanel({
  record,
  adjust,
  dateLabel,
}: {
  record: AttendanceRecord
  adjust: DayAdjust
  dateLabel: string
}) {
  const curIn = useMemo(() => (record.check_in_at ? formatTimeVn(record.check_in_at) : ""), [record.check_in_at])
  const curOut = useMemo(() => (record.check_out_at ? formatTimeVn(record.check_out_at) : ""), [record.check_out_at])
  const [inRaw, setInRaw] = useState(curIn)
  const [outRaw, setOutRaw] = useState(curOut)
  const [reason, setReason] = useState("")
  const [error, setError] = useState("")

  function save() {
    const r = buildAdjustBody(curIn, curOut, inRaw, outRaw, reason)
    if ("error" in r) {
      setError(r.error)
      return
    }
    setError("")
    adjust.submit(r.body)
  }

  return (
    <div
      className="rounded-ax-card border border-ax-primary bg-ax-surface px-6 py-5"
      data-slot="day-edit-panel"
    >
      <h3 className="mb-1 text-[15px] font-bold tracking-[-0.011em]">Sửa giờ công ngày {dateLabel}</h3>
      <p className="mb-3.5 text-[13px] text-ax-ink-2">
        Thay đổi được ghi lại cùng lý do. Nhân viên sẽ thấy giờ mới.
      </p>
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[140px] flex-1">
          <label htmlFor="adj-in" className="mb-1 block text-xs font-medium text-ax-ink-2">
            Giờ vào
          </label>
          <input
            id="adj-in"
            className={cn(AX_INPUT_CLASS, "w-full")}
            value={inRaw}
            placeholder="08:00"
            inputMode="numeric"
            maxLength={5}
            onChange={(e) => setInRaw(e.target.value)}
          />
        </div>
        <div className="min-w-[140px] flex-1">
          <label htmlFor="adj-out" className="mb-1 block text-xs font-medium text-ax-ink-2">
            Giờ ra
          </label>
          <input
            id="adj-out"
            className={cn(AX_INPUT_CLASS, "w-full")}
            value={outRaw}
            placeholder="17:30"
            inputMode="numeric"
            maxLength={5}
            onChange={(e) => setOutRaw(e.target.value)}
          />
        </div>
      </div>
      <label htmlFor="adj-why" className="mt-3.5 mb-1 block text-xs font-medium text-ax-ink-2">
        Lý do sửa (bắt buộc)
      </label>
      <textarea
        id="adj-why"
        className={cn(AX_INPUT_CLASS, "min-h-[84px] w-full resize-y py-2.5")}
        placeholder="Ví dụ: đối chiếu camera cửa hàng"
        value={reason}
        maxLength={500}
        aria-invalid={error && !reason.trim() ? true : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && (
        <p role="alert" className="mt-1.5 text-[13px] text-ax-danger">
          {error}
        </p>
      )}
      <div className="mt-3.5 flex justify-end gap-2">
        <Button variant="ax-secondary" size="ax" onClick={() => adjust.setEditing(false)}>
          Huỷ
        </Button>
        <Button variant="ax-primary" size="ax" className="px-5" onClick={save}>
          Lưu thay đổi
        </Button>
      </div>
    </div>
  )
}
