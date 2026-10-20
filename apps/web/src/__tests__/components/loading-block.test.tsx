import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { LoadingBlock } from "@/components/ui/loading-block"

describe("LoadingBlock", () => {
  it("báo trạng thái tải cho trình đọc màn hình, khối giữ chỗ lệch nhịp", () => {
    const { container } = render(<LoadingBlock count={3} avatar />)
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true")
    expect(screen.getByText("Đang tải…")).toBeTruthy()
    const blocks = container.querySelectorAll<HTMLElement>("[data-slot=skeleton]")
    expect(blocks).toHaveLength(4)
    expect(Array.from(blocks).map((b) => b.style.getPropertyValue("--sk-index"))).toEqual(["0", "1", "2", "3"])
  })
  it("kiểu thẻ: đúng số thẻ, tối đa 8", () => {
    const { container } = render(<LoadingBlock variant="cards" count={20} />)
    expect(container.querySelectorAll(".rounded-lg")).toHaveLength(8)
  })
})
