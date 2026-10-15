"use client"

import { useState } from "react"
import { FileX2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { ShellTableEmptyRow } from "@/components/app-shell/table-empty-row"
import { formatDate, formatDateTimeVn } from "@/lib/format"
import {
  REQUEST_TYPE_LABEL,
  useApproveRequest,
  useRejectRequest,
  type AttendanceRequest,
} from "@/hooks/use-attendance"

interface Props {
  rows: AttendanceRequest[]
  isLoading: boolean
  /** super_admin + hr → hiện cột Thao tác (Duyệt / Từ chối). */
  isAdmin: boolean
}

export function AdminRequestsTable({ rows, isLoading, isAdmin }: Props) {
  const approveRequest = useApproveRequest()
  const rejectRequest = useRejectRequest()
  const [rejectId, setRejectId] = useState<number | null>(null)
  const [rejectNote, setRejectNote] = useState("")

  // +1 cột "Team" chèn sau "Nhân viên".
  const colCount = isAdmin ? 9 : 8

  function handleApprove(id: number) {
    approveRequest.mutate(
      { id },
      {
        onSuccess: () => toast.success("Đã duyệt đơn"),
        onError: () => toast.error("Duyệt thất bại, vui lòng thử lại"),
      },
    )
  }

  function openReject(id: number) {
    setRejectNote("")
    setRejectId(id)
  }

  function confirmReject() {
    if (rejectId == null) return
    rejectRequest.mutate(
      { id: rejectId, review_note: rejectNote.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Đã từ chối đơn")
          setRejectId(null)
        },
        onError: () => toast.error("Từ chối thất bại, vui lòng thử lại"),
      },
    )
  }

  const desktopTable = (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
            <th className="px-4 py-3">Nhân viên</th>
            <th className="px-4 py-3">Team</th>
            <th className="px-4 py-3">Ngày</th>
            <th className="px-4 py-3">Loại đơn</th>
            <th className="px-4 py-3">Lý do</th>
            <th className="px-4 py-3">Trạng thái</th>
            <th className="px-4 py-3">Người duyệt</th>
            <th className="px-4 py-3">Thời gian tạo đơn</th>
            {isAdmin && <th className="px-4 py-3">Thao tác</th>}
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <ShellTableEmptyRow colSpan={colCount}>Đang tải...</ShellTableEmptyRow>
          ) : rows.length === 0 ? (
            <ShellTableEmptyRow colSpan={colCount}>
              Không có đơn nào khớp bộ lọc
            </ShellTableEmptyRow>
          ) : (
            rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50"
              >
                <td className="px-4 py-3 font-medium text-slate-800">{r.user_name}</td>
                <td className="px-4 py-3 text-slate-600">{r.team_name ?? "—"}</td>
                <td className="px-4 py-3 text-slate-600">{formatDate(r.work_date)}</td>
                <td className="px-4 py-3">{REQUEST_TYPE_LABEL[r.type] ?? r.type}</td>
                <td className="max-w-xs px-4 py-3 text-slate-600">
                  <p className="line-clamp-2">{r.reason}</p>
                </td>
                <td className="px-4 py-3">
                  <Badge
                    variant={
                      r.status === "approved"
                        ? "success"
                        : r.status === "rejected"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {r.status === "approved"
                      ? "Đã duyệt"
                      : r.status === "rejected"
                        ? "Từ chối"
                        : "Chờ duyệt"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-slate-500">{r.reviewer_name ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-500 tabular-nums">
                  {formatDateTimeVn(r.created_at)}
                </td>
                {isAdmin && (
                  <td className="px-4 py-3">
                    {r.status === "pending" ? (
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={approveRequest.isPending}
                          onClick={() => handleApprove(r.id)}
                        >
                          Duyệt
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openReject(r.id)}
                        >
                          Từ chối
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )

  const mobileCards = isLoading ? (
    <p className="py-10 text-center text-sm text-slate-400">Đang tải...</p>
  ) : rows.length === 0 ? (
    <ShellEmptyState icon={FileX2} description="Không có đơn nào khớp bộ lọc" />
  ) : (
    <div className="space-y-3">
      {rows.map((r) => (
        <ShellListCard key={r.id}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-slate-800">{r.user_name}</span>
            <Badge
              variant={
                r.status === "approved"
                  ? "success"
                  : r.status === "rejected"
                    ? "destructive"
                    : "secondary"
              }
            >
              {r.status === "approved"
                ? "Đã duyệt"
                : r.status === "rejected"
                  ? "Từ chối"
                  : "Chờ duyệt"}
            </Badge>
          </div>
          <ShellListCardRow label="Team" value={r.team_name ?? "—"} />
          <ShellListCardRow label="Ngày" value={formatDate(r.work_date)} />
          <ShellListCardRow label="Loại đơn" value={REQUEST_TYPE_LABEL[r.type] ?? r.type} />
          <ShellListCardRow label="Lý do" value={<span className="line-clamp-2 text-right">{r.reason}</span>} />
          <ShellListCardRow label="Người duyệt" value={r.reviewer_name ?? "—"} />
          <ShellListCardRow label="Thời gian tạo đơn" value={formatDateTimeVn(r.created_at)} />
          {isAdmin && r.status === "pending" && (
            // Từ chối (huỷ bỏ) ở TRÁI, Duyệt ở PHẢI (gần ngón cái), khe 12px, mỗi nút ≥44px.
            <div className="grid grid-cols-2 gap-3 pt-1">
              <Button size="sm" variant="outline" onClick={() => openReject(r.id)}>
                Từ chối
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={approveRequest.isPending}
                onClick={() => handleApprove(r.id)}
              >
                Duyệt
              </Button>
            </div>
          )}
        </ShellListCard>
      ))}
    </div>
  )

  return (
    <>
      <ShellResponsiveList table={desktopTable} cards={mobileCards} />

      {/* Popup từ chối đơn */}
      <Dialog
        open={rejectId != null}
        onOpenChange={(open) => {
          if (!open) setRejectId(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Từ chối đơn chấm công</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder="Lý do từ chối (tuỳ chọn)"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectId(null)}>
              Huỷ
            </Button>
            <Button
              variant="destructive"
              disabled={rejectRequest.isPending}
              onClick={confirmReject}
            >
              Xác nhận từ chối
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
