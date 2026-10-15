"use client"

import { useEffect, useState } from "react"
import { MapPin } from "lucide-react"
import { toast } from "sonner"
import apiClient from "@/lib/api-client"
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
import { Textarea } from "@/components/ui/textarea"
import { formatDate } from "@/lib/format"
import {
  useAttendanceDetail,
  usePatchAttendance,
  useDeleteAttendance,
  type AttendanceRecord,
} from "@/hooks/use-attendance"

const STATUS_LABEL: Record<string, string> = {
  // Trạng thái CHỈ theo giờ: đủ giờ = "Đủ công" kể cả muộn; muộn → cột Ghi chú.
  present: "Đủ công",
  late: "Đủ công",
  half_day: "Nửa ngày",
  insufficient: "Chưa đủ nửa ngày",
  incomplete: "Chưa đủ vào/ra",
  absent: "Vắng",
  leave: "Nghỉ phép",
  maternity: "Thai sản",
  review: "Xem xét",
}
const STATUS_OPTIONS = ["present", "half_day", "insufficient", "incomplete", "review"]
const STATUS_BADGE_CLS: Record<string, string> = {
  present: "border-emerald-300 bg-emerald-100 text-emerald-800",
  late: "border-emerald-300 bg-emerald-100 text-emerald-800",
  half_day: "border-blue-300 bg-blue-100 text-blue-800",
  insufficient: "border-orange-300 bg-orange-100 text-orange-800",
  incomplete: "border-slate-300 bg-slate-100 text-slate-700",
  review: "border-red-300 bg-red-100 text-red-800",
  leave: "border-sky-300 bg-sky-100 text-sky-800",
  maternity: "border-sky-300 bg-sky-100 text-sky-800",
}

function timeVn(iso: string | null): string {
  if (!iso) return "--:--"
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

function ProofImage({
  recordId,
  slot,
  present,
}: {
  recordId: number
  slot: "in" | "out"
  present: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    if (!present) return
    let cancelled = false
    let obj: string | null = null
    apiClient
      .get<Blob>(`/management/attendance/${recordId}/proof/${slot}`, {
        responseType: "blob",
      })
      .then((res) => {
        const blob = res.data
        if (!blob || cancelled) return
        obj = URL.createObjectURL(blob)
        setUrl(obj)
      })
      .catch(() => setErr(true))
    return () => {
      cancelled = true
      if (obj) URL.revokeObjectURL(obj)
    }
  }, [recordId, slot, present])
  if (!present)
    return <span className="text-xs text-muted-foreground">Không có ảnh</span>
  if (err) return <span className="text-xs text-destructive">Lỗi tải ảnh</span>
  if (!url)
    return <span className="text-xs text-muted-foreground">Đang tải ảnh...</span>
  return (
    <img
      src={url}
      alt="Bằng chứng"
      className="max-h-44 rounded border object-contain"
    />
  )
}

/**
 * Hiển thị VĂN PHÒNG nơi nhân viên chấm công — cơ chế chấm công theo IP văn phòng
 * không còn lưu GPS lat/lng. Ưu tiên tên văn phòng; fallback Google Maps cho bản ghi cũ có GPS.
 */
function CheckLocation({
  officeName,
  lat,
  lng,
}: {
  officeName: string | null | undefined
  lat: number | null
  lng: number | null
}) {
  if (officeName)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <MapPin className="size-3.5 shrink-0 text-primary" />
        {officeName}
      </span>
    )
  if (lat != null && lng != null)
    return (
      <a
        href={`https://www.google.com/maps?q=${lat},${lng}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-primary underline-offset-2 hover:underline"
      >
        Mở Google Maps
      </a>
    )
  return <span className="text-xs text-muted-foreground">—</span>
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2 text-center">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  )
}

export function AttendanceDetailDialog({
  recordId,
  onClose,
  canEdit,
  canDelete = false,
}: {
  recordId: number | null
  onClose: () => void
  canEdit: boolean
  canDelete?: boolean
}) {
  const { data, isLoading } = useAttendanceDetail(recordId)
  return (
    <Dialog open={recordId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col overflow-hidden max-w-[95vw] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Chi tiết chấm công</DialogTitle>
        </DialogHeader>
        {isLoading || !data ? (
          <p className="text-sm text-muted-foreground">Đang tải...</p>
        ) : (
          <DetailBody
            record={data}
            canEdit={canEdit}
            canDelete={canDelete}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailBody({
  record,
  canEdit,
  canDelete,
  onClose,
}: {
  record: AttendanceRecord
  canEdit: boolean
  canDelete: boolean
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const patch = usePatchAttendance(record.id)
  const del = useDeleteAttendance()
  const [checkIn, setCheckIn] = useState(timeVn(record.check_in_at))
  const [checkOut, setCheckOut] = useState(timeVn(record.check_out_at))
  const [status, setStatus] = useState<string>(record.status)
  const [inNote, setInNote] = useState(record.check_in_note ?? "")
  const [outNote, setOutNote] = useState(record.check_out_note ?? "")
  const wd = record.work_date.slice(0, 10)
  const overtime =
    record.total_hours != null && record.total_hours > 8
      ? `${Math.round((record.total_hours - 8) * 10) / 10}h`
      : "0h"

  function toIso(hhmm: string): string | undefined {
    if (!/^\d{2}:\d{2}$/.test(hhmm)) return undefined
    const d = new Date(`${wd}T${hhmm}:00+07:00`)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }

  async function handleSave() {
    const body: Record<string, unknown> = {
      status,
      check_in_note: inNote,
      check_out_note: outNote,
    }
    const inIso = toIso(checkIn)
    const outIso = toIso(checkOut)
    if (inIso) body.check_in_at = inIso
    if (outIso) body.check_out_at = outIso
    try {
      await patch.mutateAsync(body)
      toast.success("Đã lưu chỉnh sửa chấm công.")
      setEditing(false)
      onClose()
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response
        ?.data?.message
      toast.error(msg ?? "Lưu thất bại.")
    }
  }

  async function handleDelete() {
    try {
      await del.mutateAsync(record.id)
      toast.success("Đã xoá bản ghi chấm công. Nhân viên có thể chấm công lại.")
      onClose()
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response
        ?.data?.message
      toast.error(msg ?? "Xoá thất bại.")
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-1 pb-2">
      <div>
        <div className="text-lg font-semibold">
          {record.user?.full_name ?? `NV #${record.user_id}`}
        </div>
        <div className="text-sm text-muted-foreground">
          {record.user?.employee?.position ?? "—"} · Ngày{" "}
          {formatDate(record.work_date)}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="Tổng giờ"
          value={record.total_hours != null ? `${record.total_hours}h` : "—"}
        />
        <Stat label="Tăng ca" value={overtime} />
        <Stat label="Đi muộn" value={`${record.late_minutes ?? 0}p`} />
      </div>

      {editing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Giờ vào (HH:mm)</Label>
              <Input
                value={checkIn}
                onChange={(e) => setCheckIn(e.target.value)}
                placeholder="08:00"
                className="max-sm:h-11"
              />
            </div>
            <div className="space-y-1">
              <Label>Giờ ra (HH:mm)</Label>
              <Input
                value={checkOut}
                onChange={(e) => setCheckOut(e.target.value)}
                placeholder="17:30"
                className="max-sm:h-11"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Trạng thái</Label>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((s) => (
                <Button
                  key={s}
                  type="button"
                  size="sm"
                  variant={status === s ? "soft" : "outline"}
                  onClick={() => setStatus(s)}
                >
                  {STATUS_LABEL[s] ?? s}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label>Ghi chú vào</Label>
            <Textarea
              rows={2}
              value={inNote}
              onChange={(e) => setInNote(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Ghi chú ra</Label>
            <Textarea
              rows={2}
              value={outNote}
              onChange={(e) => setOutNote(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="text-sm font-medium">Bằng chứng vào ca</div>
            <div className="text-sm text-muted-foreground">
              Vào: {timeVn(record.check_in_at)}
            </div>
            <ProofImage
              recordId={record.id}
              slot="in"
              present={!!record.check_in_proof_key}
            />
            <CheckLocation
              officeName={record.check_in_office_name}
              lat={record.check_in_lat}
              lng={record.check_in_lng}
            />
            {record.check_in_note && (
              <div className="text-xs text-muted-foreground">
                Ghi chú: {record.check_in_note}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">Bằng chứng kết ca</div>
            <div className="text-sm text-muted-foreground">
              Ra: {timeVn(record.check_out_at)}
            </div>
            <ProofImage
              recordId={record.id}
              slot="out"
              present={!!record.check_out_proof_key}
            />
            <CheckLocation
              officeName={record.check_out_office_name}
              lat={record.check_out_lat}
              lng={record.check_out_lng}
            />
            {record.check_out_note && (
              <div className="text-xs text-muted-foreground">
                Ghi chú: {record.check_out_note}
              </div>
            )}
          </div>
        </div>
      )}

      {!editing && (
        <div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              STATUS_BADGE_CLS[record.status] ??
              "border-slate-300 bg-slate-100 text-slate-700"
            }`}
          >
            {STATUS_LABEL[record.status] ?? record.status}
          </span>
        </div>
      )}

      </div>

      <DialogFooter className="shrink-0 flex-col gap-2 border-t pt-3 sm:flex-row sm:justify-end">
        {confirmDelete ? (
          <div className="flex w-full flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-destructive">
              Xoá bản ghi này? Nhân viên sẽ chấm công lại từ đầu.
            </span>
            <div className="flex gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={del.isPending}
              >
                Huỷ
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={del.isPending}
              >
                {del.isPending ? "Đang xoá…" : "Xoá"}
              </Button>
            </div>
          </div>
        ) : editing ? (
          <>
            <Button variant="outline" onClick={() => setEditing(false)}>
              Huỷ
            </Button>
            <Button onClick={handleSave} disabled={patch.isPending}>
              {patch.isPending ? "Đang lưu..." : "Lưu thay đổi"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
            {canDelete && (
              // <640px xếp dọc — Xoá bản ghi lên ĐẦU, tách khỏi nút chính "Chỉnh sửa" ở đáy.
              <Button
                variant="destructive"
                className="max-sm:order-first"
                onClick={() => setConfirmDelete(true)}
              >
                Xoá bản ghi
              </Button>
            )}
            {canEdit && <Button onClick={() => setEditing(true)}>Chỉnh sửa</Button>}
          </>
        )}
      </DialogFooter>
    </div>
  )
}
