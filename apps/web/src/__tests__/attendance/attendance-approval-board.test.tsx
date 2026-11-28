import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { AttendanceApprovalBoard } from "@/app/(dashboard)/attendance/_components/attendance-approval-board"

const approveMutate = vi.fn()
const rejectMutate = vi.fn()
const showUndoToast = vi.fn()

const req = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: 100 + id,
  user_name: name,
  work_date: "2026-11-27",
  type: "forgot_check_in",
  requested_check_in: "08:00",
  requested_check_out: null,
  reason: `Lý do của ${name}`,
  status: "pending",
  reviewed_by: null,
  reviewer_name: null,
  reviewed_at: null,
  review_note: null,
  created_at: "2026-11-28T00:41:00Z",
  team_name: "Cửa hàng Quận 1",
  ...over,
})

vi.mock("@/hooks/use-attendance", () => ({
  REQUEST_TYPE_LABEL: { forgot_check_in: "Quên chấm vào", early_leave: "Xin về sớm" },
  useAttendanceRequests: () => ({
    data: { data: [req(1, "Nguyễn Thị Lan"), req(2, "Trần Văn Hậu", { type: "early_leave", requested_check_in: null, requested_check_out: "16:00" })], pagination: { total: 2 } },
    isLoading: false,
    isError: false,
    refetch: () => Promise.resolve({}),
  }),
  useRequestConfig: () => ({ data: { default_check_in: "08:00", default_check_out: "17:30", monthly_forgot_limit: 3, monthly_late_early_limit: 2 } }),
  useTodaySummary: () => ({ data: { work_date: "2026-11-28", total: 10, checked_in: 6, present: 5, incomplete: 1, absent: 4 } }),
  useAttendanceList: () => ({ data: { data: [{ id: 1, late_minutes: 12 }, { id: 2, late_minutes: 0 }], pagination: { total: 2 } } }),
  useAttendanceDetail: () => ({ data: undefined }),
  useApproveRequest: () => ({ mutate: approveMutate }),
  useRejectRequest: () => ({ mutate: rejectMutate }),
}))
vi.mock("@/components/ui/undo-toast", () => ({ showUndoToast: (...a: unknown[]) => showUndoToast(...a) }))
const toastInfo = vi.fn()
const toastDismiss = vi.fn()
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: (...a: unknown[]) => toastInfo(...a), dismiss: (...a: unknown[]) => toastDismiss(...a) },
}))

describe("AttendanceApprovalBoard", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    approveMutate.mockClear()
    rejectMutate.mockClear()
    showUndoToast.mockClear()
    showUndoToast.mockReturnValue("toast-1")
    toastInfo.mockClear()
    toastDismiss.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it("hiện số liệu, danh sách và chi tiết đơn đầu tiên", () => {
    render(<AttendanceApprovalBoard />)
    expect(screen.getByRole("heading", { name: "Đơn chờ duyệt" })).toBeInTheDocument()
    expect(screen.getByText("Chờ duyệt (2)")).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2, name: "Nguyễn Thị Lan" })).toBeInTheDocument()
    expect(screen.getByText("Xin bổ sung giờ vào")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Duyệt đơn" })).toBeInTheDocument()
  })

  it("Duyệt đơn: giữ 5 giây cho Hoàn tác rồi mới gọi API", () => {
    render(<AttendanceApprovalBoard />)
    fireEvent.click(screen.getByRole("button", { name: "Duyệt đơn" }))
    expect(showUndoToast).toHaveBeenCalledWith(expect.stringContaining("Nguyễn Thị Lan"), expect.anything())
    expect(approveMutate).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(5100)
    })
    expect(approveMutate).toHaveBeenCalledTimes(1)
    expect(approveMutate.mock.calls[0][0]).toEqual({ id: 1, review_note: undefined })
  })

  it("Hoàn tác trong 5 giây thì không gọi API", () => {
    render(<AttendanceApprovalBoard />)
    fireEvent.click(screen.getByRole("button", { name: "Duyệt đơn" }))
    const { onUndo } = showUndoToast.mock.calls[0][1] as { onUndo: () => void }
    act(() => onUndo())
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(approveMutate).not.toHaveBeenCalled()
  })

  it("Từ chối mở ô lý do và gửi kèm ghi chú", () => {
    render(<AttendanceApprovalBoard />)
    fireEvent.click(screen.getByRole("button", { name: "Từ chối" }))
    fireEvent.change(screen.getByLabelText(/Lý do từ chối/), { target: { value: "Hết hạn mức" } })
    fireEvent.click(screen.getByRole("button", { name: "Từ chối đơn" }))
    act(() => {
      vi.advanceTimersByTime(5100)
    })
    expect(rejectMutate.mock.calls[0][0]).toEqual({ id: 1, review_note: "Hết hạn mức" })
  })

  it("rời trang khi còn quyết định chờ thì gửi ngay", () => {
    const { unmount } = render(<AttendanceApprovalBoard />)
    fireEvent.click(screen.getByRole("button", { name: "Duyệt đơn" }))
    unmount()
    expect(approveMutate).toHaveBeenCalledTimes(1)
  })

  it("hết 5 giây (toast còn mở do rê chuột) thì Hoàn tác không giả vờ mở lại đơn", () => {
    render(<AttendanceApprovalBoard />)
    fireEvent.click(screen.getByRole("button", { name: "Duyệt đơn" }))
    const { onUndo } = showUndoToast.mock.calls[0][1] as { onUndo: () => void }
    act(() => {
      vi.advanceTimersByTime(5100)
    })
    expect(approveMutate).toHaveBeenCalledTimes(1)
    expect(toastDismiss).toHaveBeenCalledWith("toast-1")
    act(() => onUndo())
    expect(toastInfo).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Chờ duyệt (1)")).toBeInTheDocument()
  })
})
