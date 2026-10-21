import { fireEvent, render, screen } from "@testing-library/react"
import { AxiosError } from "axios"
import { describe, expect, it, vi } from "vitest"
import { NeedsReviewView } from "@/app/(dashboard)/dashboard/_components/home-side"

describe("Cần bạn xem — lỗi tải không được nói là 'không có gì'", () => {
  it("lỗi + chưa có mục ⇒ khung lỗi + Thử lại, không có câu trống", () => {
    const retry = vi.fn()
    render(<NeedsReviewView loading={false} items={[]} total={null} error={new AxiosError("Network Error", "ERR_NETWORK")} onRetry={retry} />)
    expect(screen.queryByTestId("need-review-empty")).toBeNull()
    expect(screen.getByRole("alert").textContent).toContain("Không tải được việc cần xem")
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it("không lỗi + trống ⇒ câu trống như cũ; tổng có đơn vị", () => {
    render(<NeedsReviewView loading={false} items={[]} total={0} />)
    expect(screen.getByTestId("need-review-empty")).toBeTruthy()
    expect(screen.getByText("0 mục")).toBeTruthy()
  })
})
