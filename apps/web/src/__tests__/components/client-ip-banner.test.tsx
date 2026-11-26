import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { ClientIpBanner } from "@/components/client-ip-banner"

const status = vi.fn()
vi.mock("@/hooks/use-client-ip-alert", () => ({ useClientIpAlert: () => ({ data: status() }) }))

describe("ClientIpBanner", () => {
  beforeEach(() => status.mockReset())

  it("không hiện gì khi không có cảnh báo (người không phải quản trị nhận warning null)", () => {
    status.mockReturnValue({ warning: null })
    const { container, rerender } = render(<ClientIpBanner />)
    expect(container).toBeEmptyDOMElement()
    status.mockReturnValue(undefined)
    rerender(<ClientIpBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it("hiện câu cảnh báo cấu hình IP", () => {
    status.mockReturnValue({ warning: "Máy chủ không xác định được IP thật của người dùng (loopback)." })
    render(<ClientIpBanner />)
    expect(screen.getByTestId("client-ip-banner").textContent).toContain("không xác định được IP thật")
  })
})
