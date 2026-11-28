import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import {
  buildAdjustBody,
  normalizeHm,
  DayEditControls,
  DayEditPanel,
  useDayAdjust,
} from "@/app/(dashboard)/attendance/_components/attendance-day-edit"
import type { AttendanceRecord } from "@/hooks/use-attendance"

const adjustMutate = vi.fn()
const showUndoToast = vi.fn()
let edits: unknown[] = []

vi.mock("@/hooks/use-attendance", () => ({
  useAdjustAttendance: () => ({ mutate: adjustMutate }),
  useAttendanceEdits: () => ({ data: edits }),
}))
vi.mock("@/components/ui/undo-toast", () => ({ showUndoToast: (...a: unknown[]) => showUndoToast(...a) }))
const toastInfo = vi.fn()
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: (...a: unknown[]) => toastInfo(...a), dismiss: vi.fn() },
}))

// 08:30 → 17:30 giờ VN (UTC+7).
const record = {
  id: 7,
  user_id: 3,
  work_date: "2026-11-27",
  check_in_at: "2026-11-27T01:30:00.000Z",
  check_out_at: "2026-11-27T10:30:00.000Z",
} as unknown as AttendanceRecord

function Harness({ rec = record }: { rec?: AttendanceRecord | null }) {
  const adjust = useDayAdjust(rec, "Nguyễn Thị Lan")
  return (
    <div>
      <span data-testid="in">{adjust.inText || "Chưa có"}</span>
      <span data-testid="out">{adjust.outText || "Chưa có"}</span>
      <DayEditControls record={rec} adjust={adjust} allowEdit />
      {adjust.editing && rec && <DayEditPanel record={rec} adjust={adjust} dateLabel="27/11/2026" />}
    </div>
  )
}

describe("normalizeHm / buildAdjustBody", () => {
  it("chuẩn hoá giờ 24h", () => {
    expect(normalizeHm("8:05")).toBe("08:05")
    expect(normalizeHm(" 17:30 ")).toBe("17:30")
    for (const bad of ["24:00", "08:60", "8h", "0805", ""]) expect(normalizeHm(bad)).toBeNull()
  })

  it("chỉ gửi giờ đã đổi, kèm lý do đã cắt khoảng trắng", () => {
    expect(buildAdjustBody("08:30", "17:30", "8:00", "17:30", "  camera  ")).toEqual({
      body: { check_in: "08:00", reason: "camera" },
    })
    expect(buildAdjustBody("", "17:30", "08:00", "17:30", "quên chấm")).toEqual({
      body: { check_in: "08:00", reason: "quên chấm" },
    })
  })

  it("báo lỗi: sai dạng, ra trước vào, không đổi, thiếu lý do", () => {
    expect(buildAdjustBody("08:30", "17:30", "8h", "17:30", "x")).toEqual({ error: "Giờ nhập dạng 24h, ví dụ 08:05." })
    expect(buildAdjustBody("08:30", "17:30", "18:00", "17:30", "x")).toEqual({ error: "Giờ ra phải sau giờ vào." })
    expect(buildAdjustBody("08:30", "17:30", "08:30", "17:30", "x")).toEqual({
      error: "Chưa đổi giờ vào hay giờ ra nào.",
    })
    expect(buildAdjustBody("08:30", "17:30", "08:00", "17:30", "  ")).toEqual({
      error: "Nhập lý do sửa để lưu lại lịch sử.",
    })
  })
})

describe("Sửa giờ công kèm lý do", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    adjustMutate.mockClear()
    showUndoToast.mockClear()
    showUndoToast.mockReturnValue("toast-1")
    toastInfo.mockClear()
    edits = []
  })
  afterEach(() => vi.useRealTimers())

  function openAndFill(inVal: string, why: string) {
    fireEvent.click(screen.getByRole("button", { name: "Sửa giờ công" }))
    fireEvent.change(screen.getByLabelText("Giờ vào"), { target: { value: inVal } })
    fireEvent.change(screen.getByLabelText(/Lý do sửa/), { target: { value: why } })
  }

  it("không có lý do thì báo lỗi và không gửi", () => {
    render(<Harness />)
    openAndFill("08:00", "")
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Nhập lý do sửa để lưu lại lịch sử.")
    expect(showUndoToast).not.toHaveBeenCalled()
    expect(adjustMutate).not.toHaveBeenCalled()
  })

  it("lưu: hiện giờ mới ngay, giữ 5 giây cho Hoàn tác rồi mới gọi API", () => {
    render(<Harness />)
    expect(screen.getByTestId("in")).toHaveTextContent("08:30")
    openAndFill("8:00", " Đối chiếu camera ")
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }))
    expect(showUndoToast).toHaveBeenCalledWith(expect.stringContaining("Nguyễn Thị Lan"), expect.anything())
    expect(screen.getByTestId("in")).toHaveTextContent("08:00")
    expect(screen.queryByLabelText("Giờ vào")).not.toBeInTheDocument()
    expect(adjustMutate).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(5100)
    })
    expect(adjustMutate).toHaveBeenCalledTimes(1)
    expect(adjustMutate.mock.calls[0][0]).toEqual({ id: 7, body: { check_in: "08:00", reason: "Đối chiếu camera" } })
  })

  it("Hoàn tác trong 5 giây thì không gọi API và trả giờ cũ", () => {
    render(<Harness />)
    openAndFill("08:00", "x")
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }))
    const { onUndo } = showUndoToast.mock.calls[0][1] as { onUndo: () => void }
    act(() => onUndo())
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(adjustMutate).not.toHaveBeenCalled()
    expect(screen.getByTestId("in")).toHaveTextContent("08:30")
  })

  it("rời trang khi còn lần sửa chờ thì gửi ngay", () => {
    const { unmount } = render(<Harness />)
    openAndFill("08:00", "x")
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }))
    unmount()
    expect(adjustMutate).toHaveBeenCalledTimes(1)
  })

  it("hiện dòng «Đã sửa tay…» từ lần sửa gần nhất", () => {
    edits = [
      {
        id: 2,
        record_id: 7,
        editor_name: "Chị Lan Anh",
        reason: "Đối chiếu camera",
        created_at: "2026-11-28T01:25:00.000Z",
      },
    ]
    render(<Harness />)
    expect(screen.getByText(/Đã sửa tay lúc 08:25 28\/11\/2026 bởi Chị Lan Anh\. Lý do: Đối chiếu camera/)).toBeInTheDocument()
  })

  it("chưa có bản ghi thì không có nút sửa", () => {
    render(<Harness rec={null} />)
    expect(screen.queryByRole("button", { name: "Sửa giờ công" })).not.toBeInTheDocument()
  })
})
