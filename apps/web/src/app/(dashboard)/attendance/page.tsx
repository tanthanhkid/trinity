"use client"

/* =============================================================================
 * /attendance — giao diện «Ánh xanh» (thiết kế chamcong-desktop / -mobile / -mobile2).
 * - Điện thoại (và mọi người dùng không có quyền duyệt): màn chấm công của nhân viên.
 * - Desktop ≥1024px + quyền `attendance.manage`: mặc định là màn QUẢN LÝ DUYỆT ĐƠN, tab bên cạnh
 *   «Chấm công của tôi» mở màn nhân viên (vì quản lý cũng tự chấm công).
 * - «Tạo đơn» mở form riêng (điện thoại: toàn màn có nút quay lại; desktop: khung giữa) rồi màn «Đơn đã gửi». */
import { useState } from "react"
import { BarChart3, Check, ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"
import { AttendanceApprovalBoard } from "./_components/attendance-approval-board"
import { AttendanceEmployeeView } from "./_components/attendance-employee-view"
import { AttendanceRequestForm } from "./_components/attendance-request-form"
import { AttendanceStatsDialog } from "./_components/attendance-stats-dialog"

type Screen = "main" | "create" | "sent"

export default function AttendancePage() {
  const { user } = useAuth()
  const { can, scopeOf } = usePermissions()
  const isDesktop = useIsDesktop()
  const userId = user?.id
  // Ai có `attendance.view` với phạm vi rộng hơn "own" xem thống kê chấm công
  // của team/phòng/toàn bộ (BE tự scope theo `manager_id`).
  const viewScope = scopeOf("attendance.view")
  const canViewTeamStats = viewScope !== null && viewScope !== "own"
  const canApprove = can("attendance.manage")
  const [statsOpen, setStatsOpen] = useState(false)
  const [screen, setScreen] = useState<Screen>("main")
  const [sent, setSent] = useState<{ typeLabel: string; dateDisplay: string } | null>(null)
  const [mode, setMode] = useState<"approve" | "mine">("approve")

  const showBoard = isDesktop && canApprove && mode === "approve"

  const statsButton = canViewTeamStats && (
    <Button variant="ax-secondary" size="ax" className="shrink-0 gap-2" onClick={() => setStatsOpen(true)}>
      <BarChart3 className="size-4" />
      Thống kê chấm công nhóm
    </Button>
  )

  if (screen !== "main") {
    return (
      <div className="mx-auto w-full max-w-[640px] pb-4">
        <div className="-ml-2">
          <Button variant="ax-ghost" size="ax" className="gap-0.5 text-ax-primary-ink" onClick={() => setScreen("main")}>
            <ChevronLeft className="size-5" aria-hidden />
            Chấm công
          </Button>
        </div>
        {screen === "create" ? (
          <>
            <h1 className="ax-text-title mt-0.5 mb-3 px-1 text-[28px] text-ax-ink">Tạo đơn</h1>
            <AttendanceRequestForm
              userId={userId}
              onSent={(info) => {
                setSent(info)
                setScreen("sent")
              }}
            />
          </>
        ) : (
          <div className="flex flex-col pt-10">
            <div aria-hidden className="flex size-14 items-center justify-center rounded-ax-card bg-ax-success-soft text-ax-success">
              <Check className="size-7" strokeWidth={2.4} />
            </div>
            <h1 className="ax-text-title mt-4 mb-1.5 text-ax-ink">Đơn đã gửi</h1>
            <p className="text-base leading-normal text-ax-ink-2">
              {sent ? `${sent.typeLabel} ngày ${sent.dateDisplay} đã chuyển cho quản lý.` : ""} Có kết quả bạn
              nhận thông báo.
            </p>
            <Button variant="ax-primary" size="ax-lg" className="mt-7 w-full" onClick={() => setScreen("main")}>
              Về chấm công
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={cn("mx-auto w-full space-y-4", showBoard ? "max-w-[1440px]" : "max-w-[1100px]")}>
      {(canApprove && isDesktop) || statsButton ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {canApprove && isDesktop ? (
            <div role="tablist" aria-label="Chế độ xem" className="flex gap-1 rounded-ax-card bg-ax-sunken p-1">
              {(
                [
                  ["approve", "Duyệt đơn"],
                  ["mine", "Chấm công của tôi"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={mode === key}
                  onClick={() => setMode(key)}
                  className={cn(
                    "h-10 cursor-pointer rounded-ax-field px-4 text-sm font-semibold text-ax-ink-2 outline-none transition-colors",
                    "hover:text-ax-ink focus-visible:shadow-[var(--ax-focus-ring)]",
                    mode === key && "bg-ax-surface text-ax-ink shadow-ax-card",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          {statsButton}
        </div>
      ) : null}

      {showBoard ? (
        <AttendanceApprovalBoard />
      ) : (
        <AttendanceEmployeeView userId={userId} onCreate={() => setScreen("create")} />
      )}

      {canViewTeamStats && <AttendanceStatsDialog open={statsOpen} onOpenChange={setStatsOpen} />}
    </div>
  )
}
