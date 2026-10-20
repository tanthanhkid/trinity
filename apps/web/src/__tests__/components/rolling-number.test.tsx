import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { RollingNumber, rollingParts } from "@/components/ui/rolling-number"

describe("RollingNumber", () => {
  it("chữ số khoá theo hàng tính từ phải, dấu và chữ đứng yên", () => {
    const parts = rollingParts("1.234 ₫")
    expect(parts.filter((p) => "digit" in p).map((p) => p.key)).toEqual(["d3", "d2", "d1", "d0"])
    expect(parts.filter((p) => "text" in p).map((p) => (p as { text: string }).text)).toEqual([".", " ", "₫"])
  })
  it("trình đọc màn hình đọc nguyên chuỗi; chuỗi không có số thì hiện thẳng", () => {
    render(<RollingNumber text="140.253.800 ₫" />)
    expect(screen.getByText("140.253.800 ₫")).toBeTruthy()
    render(<RollingNumber text="—" />)
    expect(screen.getByText("—")).toBeTruthy()
  })
})
