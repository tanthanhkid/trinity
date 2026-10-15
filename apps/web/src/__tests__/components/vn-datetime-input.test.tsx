import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { VnDateTimeInput } from "@/components/ui/vn-datetime-input"
import { InlineSelect } from "@/components/ui/inline-select"

describe("VnDateTimeInput", () => {
  it("hiển thị dd/mm/yyyy HH:mm từ giá trị datetime-local", () => {
    render(<VnDateTimeInput value="2026-10-03T09:05" onChange={() => {}} ariaLabel="Hạn" />)
    expect((screen.getByLabelText("Hạn") as HTMLInputElement).value).toBe("03/10/2026 09:05")
  })

  it("gõ đủ hợp lệ mới phát giá trị; dở dang thì không", () => {
    const onChange = vi.fn()
    render(<VnDateTimeInput value="" onChange={onChange} ariaLabel="Hạn" />)
    const input = screen.getByLabelText("Hạn")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "03102026" } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: "031020260905" } })
    expect(onChange).toHaveBeenCalledWith("2026-10-03T09:05")
  })

  it("chọn ngày trên lịch giữ nguyên giờ đã có", () => {
    const onChange = vi.fn()
    render(<VnDateTimeInput value="2026-10-03T09:05" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText("Mở lịch"))
    fireEvent.click(screen.getByRole("button", { name: "Ngày 15/10/2026" }))
    expect(onChange).toHaveBeenCalledWith("2026-10-15T09:05")
  })

  it("nút Xoá phát chuỗi rỗng", () => {
    const onChange = vi.fn()
    render(<VnDateTimeInput value="2026-10-03T09:05" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText("Mở lịch"))
    fireEvent.click(screen.getByRole("button", { name: "Xoá" }))
    expect(onChange).toHaveBeenCalledWith("")
  })
})

describe("InlineSelect", () => {
  it("option disabled không chọn được; size sm dùng h-9", () => {
    const onChange = vi.fn()
    render(
      <InlineSelect<number> size="sm" value={null} onChange={onChange}
        options={[{ value: 1, label: "A" }, { value: 2, label: "B", disabled: true }]} />,
    )
    const trigger = screen.getByRole("combobox")
    expect(trigger.className).toContain("h-9")
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("option", { name: "B" }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("option", { name: "A" }))
    expect(onChange).toHaveBeenCalledWith(1)
  })

  it("clearLabel thêm option bỏ chọn trả null", () => {
    const onChange = vi.fn()
    render(<InlineSelect<number> value={1} onChange={onChange} clearLabel="Không" options={[{ value: 1, label: "A" }]} />)
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "Không" }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
