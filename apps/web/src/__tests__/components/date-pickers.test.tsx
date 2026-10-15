import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"
import { Calendar } from "@/components/ui/calendar"
import { DatePicker } from "@/components/ui/date-picker"
import { DateRangePicker } from "@/components/ui/date-range-picker"
import { MonthPicker } from "@/components/ui/month-picker"
import { VnDateInput } from "@/components/ui/vn-date-input"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

const day = (iso: string) => {
  const [y, m, d] = iso.split("-")
  return screen.getByRole("button", { name: `Ngày ${d}/${m}/${y}` })
}

describe("Calendar (vi)", () => {
  it("tuần bắt đầu Thứ Hai, thứ T2..CN, tiêu đề tiếng Việt", () => {
    render(<Calendar mode="single" defaultMonth={new Date(2026, 9, 1)} />)
    const heads = Array.from(document.querySelectorAll("thead th")).map((h) => h.textContent)
    expect(heads).toEqual(["T2", "T3", "T4", "T5", "T6", "T7", "CN"])
    expect(screen.getByText("Tháng 10, 2026")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Xem tháng trước" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Xem tháng sau" })).toBeTruthy()
  })
})

describe("VnDateInput + lịch mới", () => {
  it("chọn ngày trên lịch phát ISO yyyy-mm-dd, không lệch múi giờ", () => {
    const onChange = vi.fn()
    render(<VnDateInput value="2026-10-03" onChange={onChange} ariaLabel="Ngày" />)
    fireEvent.click(screen.getByLabelText("Mở lịch"))
    fireEvent.click(day("2026-10-31"))
    expect(onChange).toHaveBeenCalledWith("2026-10-31")
  })

  it("vẫn gõ tay dd/mm/yyyy và clamp theo max", () => {
    const onChange = vi.fn()
    render(<VnDateInput value="" max="2026-10-10" onChange={onChange} ariaLabel="Ngày" />)
    const input = screen.getByLabelText("Ngày")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "05102026" } })
    expect(onChange).toHaveBeenCalledWith("2026-10-05")
    fireEvent.change(input, { target: { value: "20102026" } })
    expect(onChange).toHaveBeenLastCalledWith("2026-10-10")
  })

  it("ngày ngoài [min,max] bị khoá trên lịch", () => {
    render(<VnDateInput value="2026-10-05" min="2026-10-02" max="2026-10-10" onChange={() => {}} />)
    fireEvent.click(screen.getByLabelText("Mở lịch"))
    expect((day("2026-10-11") as HTMLButtonElement).disabled).toBe(true)
    expect((day("2026-10-01") as HTMLButtonElement).disabled).toBe(true)
    expect((day("2026-10-09") as HTMLButtonElement).disabled).toBe(false)
  })

  it("nút Xoá phát chuỗi rỗng", () => {
    const onChange = vi.fn()
    render(<VnDateInput value="2026-10-05" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText("Mở lịch"))
    fireEvent.click(screen.getByRole("button", { name: "Xoá" }))
    expect(onChange).toHaveBeenCalledWith("")
  })
})

describe("DatePicker", () => {
  it("hiện dd/mm/yyyy và phát ISO", () => {
    const onChange = vi.fn()
    render(<DatePicker value="2026-01-09" onChange={onChange} ariaLabel="Sinh nhật" />)
    expect(screen.getByRole("button", { name: "Sinh nhật" }).textContent).toBe("09/01/2026")
    fireEvent.click(screen.getByRole("button", { name: "Sinh nhật" }))
    fireEvent.click(day("2026-01-20"))
    expect(onChange).toHaveBeenCalledWith("2026-01-20")
  })

  it("popup nằm trong cây DOM của Dialog và chọn ngày không đóng Dialog", () => {
    const onChange = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Form</DialogTitle>
          <DatePicker value="2026-10-03" onChange={onChange} ariaLabel="Hạn" />
        </DialogContent>
      </Dialog>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Hạn" }))
    const dialog = document.querySelector("[data-slot=dialog-content]") as HTMLElement
    expect(within(dialog).getByRole("button", { name: "Ngày 15/10/2026" })).toBeTruthy()
    fireEvent.pointerDown(day("2026-10-15"))
    fireEvent.mouseDown(day("2026-10-15"))
    fireEvent.click(day("2026-10-15"))
    expect(onChange).toHaveBeenCalledWith("2026-10-15")
    expect(onOpenChange).not.toHaveBeenCalledWith(false, expect.anything())
  })
})

describe("DatePicker trong Dialog bị cắt (overflow-hidden)", () => {
  it("portal ra body nhưng bấm trong popup vẫn không đóng Dialog", () => {
    const onChange = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent style={{ overflow: "hidden" }}>
          <DialogTitle>Form</DialogTitle>
          <DatePicker value="2026-10-03" onChange={onChange} ariaLabel="Hạn" />
        </DialogContent>
      </Dialog>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Hạn" }))
    const cell = day("2026-10-15")
    expect(cell.closest("[data-slot=dialog-content]")).toBeNull()
    fireEvent.pointerDown(cell)
    fireEvent.mouseDown(cell)
    fireEvent.click(cell)
    expect(onChange).toHaveBeenCalledWith("2026-10-15")
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe("DateRangePicker", () => {
  function Harness({ onChange }: { onChange: (r: { date_from: string; date_to: string }) => void }) {
    const [v, setV] = useState({ date_from: "2026-10-01", date_to: "2026-10-03" })
    return <DateRangePicker value={v} max="2026-10-20" onChange={(r) => { setV(r); onChange(r) }} />
  }

  it("hiện khoảng dd/mm/yyyy – dd/mm/yyyy", () => {
    render(<Harness onChange={() => {}} />)
    expect(screen.getByRole("button", { name: "Chọn khoảng ngày" }).textContent).toBe("01/10/2026 – 03/10/2026")
  })

  it("bấm 2 ngày phát khoảng ISO đúng thứ tự (kể cả bấm ngược)", () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Chọn khoảng ngày" }))
    fireEvent.click(day("2026-10-14"))
    expect(onChange).not.toHaveBeenCalled() // mới chọn ngày đầu
    fireEvent.click(day("2026-10-08"))
    expect(onChange).toHaveBeenCalledWith({ date_from: "2026-10-08", date_to: "2026-10-14" })
  })

  it("bấm cùng một ngày 2 lần = khoảng 1 ngày", () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Chọn khoảng ngày" }))
    fireEvent.click(day("2026-10-09"))
    fireEvent.click(day("2026-10-09"))
    expect(onChange).toHaveBeenCalledWith({ date_from: "2026-10-09", date_to: "2026-10-09" })
  })

  it("không chọn được ngày sau max", () => {
    render(<Harness onChange={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Chọn khoảng ngày" }))
    expect((day("2026-10-21") as HTMLButtonElement).disabled).toBe(true)
  })

  it("có khoảng nhanh tiếng Việt; 'Hôm nay' phát khoảng 1 ngày", () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Chọn khoảng ngày" }))
    for (const l of ["Hôm nay", "7 ngày qua", "30 ngày qua", "Tháng này", "Tháng trước"]) {
      expect(screen.getByRole("button", { name: l })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole("button", { name: "Hôm nay" }))
    const arg = onChange.mock.calls[0][0]
    expect(arg.date_from).toBe(arg.date_to)
    expect(arg.date_from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe("MonthPicker", () => {
  it("hiện mm/yyyy và phát YYYY-MM", () => {
    const onChange = vi.fn()
    render(<MonthPicker value="2026-03" onChange={onChange} ariaLabel="Hiệu lực" />)
    expect(screen.getByRole("button", { name: "Hiệu lực" }).textContent).toBe("03/2026")
    fireEvent.click(screen.getByRole("button", { name: "Hiệu lực" }))
    fireEvent.click(screen.getByRole("button", { name: "Năm sau" }))
    fireEvent.click(screen.getByRole("button", { name: "Tháng 11 năm 2027" }))
    expect(onChange).toHaveBeenCalledWith("2027-11")
  })
})
