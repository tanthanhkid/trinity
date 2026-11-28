"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Inbox } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { PersonAvatar } from "@/components/ui/avatar"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { HeroCard, HeroCardLabel, HeroCardTile } from "@/components/ui/hero-card"
import { StickyActionBar } from "@/components/ui/sticky-action-bar"
import { AX_INPUT_CLASS } from "@/components/ui/input"
import { showUndoToast } from "@/components/ui/undo-toast"
import { errorMessage } from "@/lib/error-messages"
import { cn } from "@/lib/utils"
import { formatDateTimeVn, formatTimeVn, isoToVnDate, todayVn } from "@/lib/format"
import {
  REQUEST_TYPE_LABEL,
  useApproveRequest,
  useAttendanceDetail,
  useAttendanceList,
  useAttendanceRequests,
  useRejectRequest,
  useRequestConfig,
  useTodaySummary,
  type AttendanceRequest,
} from "@/hooks/use-attendance"
import { askOf, computeQuota, nameInitials } from "./attendance-board-utils"
import { RequestStatusPill } from "./request-status-pill"

/** Quyết định đã bấm nhưng còn trong 5 giây Hoàn tác — chưa gọi máy chủ. */
interface PendingDecision {
  status: "approved" | "rejected"
  note: string
}

/** Thời gian giữ quyết định chờ Hoàn tác (ms) — bằng thời gian toast tự ẩn. */
const UNDO_WINDOW_MS = 5000

function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div
      data-slot="approval-stat"
      className="ax-card ax-grad-stat min-w-[120px] px-4 py-2.5"
    >
      <div className="text-[13px] text-ax-ink-3">{label}</div>
      <div className="ax-amount text-[22px] leading-tight font-bold text-ax-ink" title={hint}>
        {value}
      </div>
    </div>
  )
}

/** Thời điểm tạo đơn: hôm nay chỉ giờ, ngày khác chỉ ngày (kèm `title` đầy đủ ở chỗ gọi). */
function createdShort(iso: string): string {
  const full = formatDateTimeVn(iso)
  const [time, date] = full.split(" ")
  if (!time || !date) return full
  return isoToVnDate(todayVn()) === date ? time : date.slice(0, 5)
}

/**
 * Màn QUẢN LÝ DUYỆT ĐƠN của /attendance (desktop ≥1024px) — thiết kế chamcong-desktop:
 * cột trái danh sách (Chờ duyệt / Đã xử lý), cột phải chi tiết một đơn (khối nhấn xanh, công ngày,
 * hạn mức tháng), thanh Từ chối / Duyệt đơn nổi ở đáy.
 *
 * Duyệt/từ chối dùng cùng API với /management/workdays (`useApproveRequest`/`useRejectRequest`).
 * Hoàn tác: máy chủ không có API "mở lại đơn" nên quyết định được GIỮ 5 giây rồi mới gửi; bấm Hoàn tác
 * trong lúc đó = chưa gửi gì; rời trang trong 5 giây = gửi ngay (không mất quyết định).
 *
 * Chỗ chừa cho «Sửa giờ công kèm lý do» (PR riêng, cần API + tool MCP): thẻ «Công ngày» bên dưới.
 */
export function AttendanceApprovalBoard() {
  const requests = useAttendanceRequests({ page: 1, page_size: 1000 })
  const config = useRequestConfig()
  const todaySummary = useTodaySummary()
  const approve = useApproveRequest()
  const reject = useRejectRequest()

  const [tab, setTab] = useState<"pending" | "done">("pending")
  const [selId, setSelId] = useState<number | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [rejectNote, setRejectNote] = useState("")
  // Quyết định đang chờ Hoàn tác, theo id đơn (hiển thị như đã xử lý).
  const [held, setHeld] = useState<Record<number, PendingDecision>>({})
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const heldRef = useRef(held)
  useEffect(() => {
    heldRef.current = held
  }, [held])

  const all: AttendanceRequest[] = useMemo(() => requests.data?.data ?? [], [requests.data])
  const truncated = (requests.data?.pagination?.total ?? 0) > all.length

  // Đơn sau khi áp quyết định đang giữ (lạc quan).
  const view = useMemo(
    () =>
      all.map((r) => {
        const h = held[r.id]
        return h ? { ...r, status: h.status, review_note: h.note || null } : r
      }),
    [all, held],
  )
  const pending = useMemo(() => view.filter((r) => r.status === "pending"), [view])
  const done = useMemo(
    () =>
      view
        .filter((r) => r.status !== "pending")
        .sort((a, b) => (b.reviewed_at ?? b.created_at).localeCompare(a.reviewed_at ?? a.created_at)),
    [view],
  )
  const list = tab === "pending" ? pending : done
  const cur = view.find((r) => r.id === selId) ?? list[0] ?? null

  const today = todayVn()
  const todayList = useAttendanceList({
    date_from: today,
    date_to: today,
    page: 1,
    page_size: 200,
  })
  const lateToday = todayList.data
    ? todayList.data.data.filter((r) => (r.late_minutes ?? 0) > 0).length
    : null
  const lateTruncated =
    !!todayList.data && todayList.data.pagination.total > todayList.data.data.length
  const absentToday =
    todaySummary.data && "absent" in todaySummary.data ? todaySummary.data.absent : null

  // Công ngày của nhân viên gửi đơn.
  const dayList = useAttendanceList({
    date_from: cur?.work_date,
    date_to: cur?.work_date,
    user_id: cur?.user_id,
    page: 1,
    page_size: 1,
  })
  const dayRecordId = cur && dayList.data ? (dayList.data.data[0]?.id ?? null) : null
  const dayDetail = useAttendanceDetail(dayRecordId)
  const dayRecord = dayDetail.data ?? dayList.data?.data[0] ?? null

  const clearHeld = useCallback((id: number) => {
    setHeld((h) => {
      const next = { ...h }
      delete next[id]
      return next
    })
  }, [])
  const refetchRequests = requests.refetch

  const commit = useCallback(
    (id: number, d: PendingDecision) => {
      const mutation = d.status === "approved" ? approve : reject
      mutation.mutate(
        { id, review_note: d.note || undefined },
        {
          // Giữ trạng thái lạc quan tới khi danh sách tải lại, tránh đơn nháy về «Chờ duyệt».
          onSuccess: () => void refetchRequests().finally(() => clearHeld(id)),
          onError: (err) => {
            toast.error(errorMessage(err, "Chưa xử lý được đơn"))
            clearHeld(id)
          },
        },
      )
    },
    [approve, reject, refetchRequests, clearHeld],
  )
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  }, [commit])

  // Rời trang khi còn quyết định chờ Hoàn tác → gửi ngay, không để mất.
  useEffect(() => {
    const t = timers.current
    return () => {
      for (const [id, timer] of t) {
        clearTimeout(timer)
        const d = heldRef.current[id]
        if (d) commitRef.current(id, d)
      }
      t.clear()
    }
  }, [])

  function decide(status: "approved" | "rejected") {
    if (!cur) return
    const id = cur.id
    const note = status === "rejected" ? rejectNote.trim() : ""
    const d: PendingDecision = { status, note }
    const nextPending = pending.filter((r) => r.id !== id)[0]
    setHeld((h) => ({ ...h, [id]: d }))
    setSelId(nextPending ? nextPending.id : null)
    setRejecting(false)
    setRejectNote("")
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id)
        commit(id, d)
      }, UNDO_WINDOW_MS),
    )
    showUndoToast(
      `${status === "approved" ? "Đã duyệt đơn của" : "Đã từ chối đơn của"} ${cur.user_name}`,
      {
        duration: UNDO_WINDOW_MS,
        onUndo: () => {
          const timer = timers.current.get(id)
          if (timer) clearTimeout(timer)
          timers.current.delete(id)
          clearHeld(id)
          setTab("pending")
          setSelId(id)
        },
      },
    )
  }

  const quota = cur ? computeQuota(cur, view, config.data) : null
  const ask = cur ? askOf(cur) : null
  const isPending = cur?.status === "pending"
  const month = today.slice(5, 7)
  const year = today.slice(0, 4)

  return (
    <div className="flex flex-col gap-4" data-slot="attendance-approval-board">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[13px] text-ax-ink-2">
            Chấm công · Tháng {month}/{year}
          </div>
          <h1 className="ax-text-title mt-0.5 text-ax-ink">Đơn chờ duyệt</h1>
        </div>
        <div className="flex flex-wrap gap-3">
          <StatTile label="Chờ duyệt" value={requests.isLoading ? "—" : pending.length} />
          <StatTile
            label="Đi muộn hôm nay"
            value={lateToday === null ? "—" : `${lateToday}${lateTruncated ? "+" : ""}`}
          />
          <StatTile label="Chưa chấm công" value={absentToday ?? "—"} />
        </div>
      </div>

      {truncated && (
        <p className="text-[13px] text-ax-warn">
          Chỉ tải {all.length}/{requests.data?.pagination.total} đơn đầu — một số đơn cũ chưa hiện. Dùng
          Quản lý chấm công ở mục Nhân sự để lọc theo nhóm, phòng ban.
        </p>
      )}

      <div className="flex flex-wrap items-start gap-4">
        {/* Danh sách đơn */}
        <section
          aria-label="Danh sách đơn"
          className="ax-card min-w-[300px] flex-[0_1_420px] overflow-hidden"
        >
          <div role="tablist" className="flex gap-1 border-b border-ax-divider p-3">
            {(
              [
                ["pending", `Chờ duyệt (${pending.length})`],
                ["done", `Đã xử lý (${done.length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => {
                  setTab(key)
                  setRejecting(false)
                  const first = (key === "pending" ? pending : done)[0]
                  if (first) setSelId(first.id)
                }}
                className={cn(
                  "h-10 flex-1 cursor-pointer rounded-ax-field text-sm font-semibold text-ax-ink outline-none transition-colors",
                  "hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]",
                  tab === key && "bg-[var(--ax-grad-soft)] text-ax-primary-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {requests.isLoading ? (
            <div className="space-y-3 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full" index={i} />
              ))}
            </div>
          ) : requests.isError ? (
            <p role="alert" className="p-6 text-sm text-ax-danger">
              {errorMessage(requests.error, "Chưa tải được danh sách đơn")}
            </p>
          ) : list.length === 0 ? (
            <EmptyState
              variant="ax"
              icon={Inbox}
              className="m-4"
              title={tab === "pending" ? "Không còn đơn nào chờ" : "Chưa có đơn nào xử lý"}
              message={
                tab === "pending"
                  ? 'Đơn mới của nhân viên sẽ hiện ở đây. Đơn vừa xử lý xem ở tab "Đã xử lý".'
                  : "Đơn đã duyệt hoặc từ chối sẽ hiện ở đây."
              }
            />
          ) : (
            <ul>
              {list.map((r) => {
                const active = cur?.id === r.id
                return (
                  <li key={r.id} className="border-t border-ax-divider first:border-t-0">
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        setSelId(r.id)
                        setRejecting(false)
                      }}
                      className={cn(
                        "flex min-h-[44px] w-full cursor-pointer items-start gap-3 px-4 py-3.5 text-left text-ax-ink outline-none transition-colors",
                        "hover:bg-ax-hover focus-visible:shadow-[inset_0_0_0_2px_var(--ax-primary)]",
                        active && "bg-ax-primary-soft",
                      )}
                    >
                      <PersonAvatar kind="staff" name={r.user_name} />
                      <span className="min-w-0 flex-1">
                        <span className="flex justify-between gap-2">
                          <span className="truncate text-[15px] font-semibold">{r.user_name}</span>
                          <span
                            className="ax-amount shrink-0 text-[13px] text-ax-ink-3"
                            title={formatDateTimeVn(r.created_at)}
                          >
                            {createdShort(r.created_at)}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-sm text-ax-ink-2">
                          {REQUEST_TYPE_LABEL[r.type] ?? r.type} · {isoToVnDate(r.work_date)}
                        </span>
                        <span className="mt-0.5 block truncate text-[13px] text-ax-ink-2">{r.reason}</span>
                        {r.status !== "pending" && <RequestStatusPill status={r.status} className="mt-1.5" />}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* Chi tiết đơn */}
        <section aria-label="Chi tiết đơn" className="flex min-w-0 flex-[1_1_560px] flex-col gap-4">
          {cur ? (
            <>
              <HeroCard className="rounded-[14px] p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-center gap-3.5">
                    <span
                      aria-hidden
                      className="flex size-[52px] flex-none items-center justify-center rounded-full bg-gradient-to-br from-white to-[#E3EDF6] text-[17px] font-bold text-[#285680] shadow-[0_8px_18px_-8px_rgba(13,32,54,.6),0_0_0_3px_rgba(255,255,255,.16)]"
                    >
                      {nameInitials(cur.user_name)}
                    </span>
                    <div>
                      <h2 className="ax-text-title text-white">{cur.user_name}</h2>
                      <div className="ax-amount mt-0.5 text-sm text-[var(--ax-on-hero-ink-2)]">
                        {cur.team_name ?? "Chưa có team"} · gửi lúc {formatDateTimeVn(cur.created_at)}
                      </div>
                    </div>
                  </div>
                  {cur.status !== "pending" && (
                    <RequestStatusPill status={cur.status} className="px-3.5 py-1 text-sm" />
                  )}
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <HeroCardTile className="min-w-[160px] flex-1 rounded-ax-card px-4 py-3.5">
                    <HeroCardLabel className="text-xs">Loại đơn</HeroCardLabel>
                    <div className="mt-0.5 text-[17px] font-semibold tracking-[-0.011em]">
                      {REQUEST_TYPE_LABEL[cur.type] ?? cur.type}
                    </div>
                  </HeroCardTile>
                  <HeroCardTile className="min-w-[160px] flex-1 rounded-ax-card px-4 py-3.5">
                    <HeroCardLabel className="text-xs">Ngày áp dụng</HeroCardLabel>
                    <div className="ax-amount mt-0.5 text-[17px] font-semibold tracking-[-0.011em]">
                      {isoToVnDate(cur.work_date)}
                    </div>
                  </HeroCardTile>
                  {ask && (
                    <div className="min-w-[160px] flex-1 rounded-ax-card bg-white px-4 py-3.5 shadow-[0_8px_18px_-10px_rgba(13,32,54,.6)]">
                      <div className="text-xs font-medium text-[#285680]">{ask.label}</div>
                      <div className="ax-amount mt-px text-[22px] leading-[1.15] font-bold tracking-[-0.02em] text-[#285680]">
                        {ask.time}
                      </div>
                    </div>
                  )}
                </div>

                <figure className="mt-3 rounded-ax-card bg-[var(--ax-on-hero-tile)] px-4 py-3.5">
                  <figcaption className="mb-1 text-xs font-medium text-[var(--ax-on-hero-ink-2)]">
                    Lý do nhân viên ghi
                  </figcaption>
                  <blockquote className="m-0 text-[15px] leading-normal text-white">{cur.reason}</blockquote>
                </figure>
                {cur.review_note && (
                  <p className="mt-3 text-sm text-[var(--ax-on-hero-ink-2)]">Phản hồi của bạn: {cur.review_note}</p>
                )}
              </HeroCard>

              <div className="flex flex-wrap gap-4">
                <div className="ax-card flex-[1_1_280px] px-6 py-5">
                  <h3 className="mb-2.5 text-[15px] font-bold tracking-[-0.011em]">
                    Công ngày {isoToVnDate(cur.work_date)}
                  </h3>
                  <DayRow label="Giờ vào" value={dayRecord?.check_in_at ? formatTimeVn(dayRecord.check_in_at) : "Chưa có"} strong />
                  <DayRow label="Giờ ra" value={dayRecord?.check_out_at ? formatTimeVn(dayRecord.check_out_at) : "Chưa có"} strong />
                  <DayRow
                    label="Văn phòng"
                    value={
                      cur.type === "leave" || cur.type === "maternity"
                        ? "Không áp dụng"
                        : (dayRecord?.check_in_office_name ?? dayRecord?.check_out_office_name ?? "—")
                    }
                  />
                  {/* Chỗ chừa: «Sửa giờ công» kèm lý do + lịch sử sửa — làm ở PR riêng (cần API Rust + tool MCP). */}
                </div>

                <div className="ax-card flex-[1_1_280px] px-6 py-5">
                  <h3 className="mb-2.5 text-[15px] font-bold tracking-[-0.011em]">
                    Hạn mức tháng {cur.work_date.slice(5, 7)}
                  </h3>
                  {quota && quota.max !== null ? (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-ax-ink-2">{quota.label}</span>
                        <span className="ax-amount font-semibold">
                          {quota.used} / {quota.max} đơn
                        </span>
                      </div>
                      <div
                        role="img"
                        aria-label={`${quota.used} trên ${quota.max} đơn`}
                        className="mt-2 h-2 overflow-hidden rounded-[4px] bg-ax-line"
                      >
                        <div
                          className={cn("h-full", quota.over ? "bg-ax-warn" : "bg-ax-primary")}
                          style={{ width: `${quota.pct}%` }}
                        />
                      </div>
                      <p className="mt-2.5 text-[13px] leading-snug text-ax-ink-2">
                        {quota.over
                          ? "Nhân viên đã dùng hết hạn mức tháng này. Duyệt thêm là vượt quy định, nên ghi lý do ngoại lệ."
                          : `Còn ${quota.max - quota.used} đơn trong tháng. Duyệt đơn này là dùng thêm 1.`}
                      </p>
                    </>
                  ) : (
                    <p className="text-[13px] leading-snug text-ax-ink-2">
                      {quota?.label ?? "Loại đơn này"} không tính theo hạn mức đơn của tháng.
                    </p>
                  )}
                </div>
              </div>

              {rejecting && isPending && (
                <div className="rounded-ax-card border border-[var(--ax-danger-border)] bg-ax-surface px-6 py-5">
                  <label htmlFor="att-reject-note" className="mb-1 block text-[15px] font-bold">
                    Lý do từ chối (nhân viên sẽ đọc)
                  </label>
                  <textarea
                    id="att-reject-note"
                    className={cn(AX_INPUT_CLASS, "min-h-[84px] w-full resize-y py-2.5")}
                    placeholder="Ví dụ: đã hết hạn mức quên chấm tháng này"
                    value={rejectNote}
                    maxLength={500}
                    onChange={(e) => setRejectNote(e.target.value)}
                  />
                  <div className="mt-3.5 flex justify-end gap-2">
                    <Button variant="ax-secondary" size="ax" onClick={() => setRejecting(false)}>
                      Huỷ
                    </Button>
                    <Button variant="ax-danger" size="ax" onClick={() => decide("rejected")}>
                      Từ chối đơn
                    </Button>
                  </div>
                </div>
              )}

              {isPending && !rejecting && (
                <StickyActionBar layout="desktop">
                  <span className="flex-1 text-sm text-ax-ink-2">
                    {quota?.over
                      ? "Nhân viên đã hết hạn mức. Cân nhắc trước khi duyệt."
                      : `Duyệt xong, công của ${cur.user_name.trim().split(/\s+/).slice(-1)[0]} được cập nhật ngay.`}
                  </span>
                  <Button variant="ax-secondary" size="ax" onClick={() => setRejecting(true)}>
                    Từ chối
                  </Button>
                  <Button variant="ax-primary" size="ax" className="px-7" onClick={() => decide("approved")}>
                    Duyệt đơn
                  </Button>
                </StickyActionBar>
              )}
            </>
          ) : (
            !requests.isLoading && (
              <EmptyState
                variant="ax"
                icon={Inbox}
                title="Chưa chọn đơn nào"
                message="Chọn một đơn ở danh sách bên trái để xem chi tiết và duyệt."
              />
            )
          )}
        </section>
      </div>
    </div>
  )
}

function DayRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between border-t border-ax-divider py-2 text-[15px]">
      <span className="text-ax-ink-2">{label}</span>
      <span className={cn("ax-amount", strong && "font-semibold")}>{value}</span>
    </div>
  )
}
