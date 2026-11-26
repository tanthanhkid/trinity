import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { ChannelGuardBanner } from "@/components/channel-guard-banner"

const status = vi.fn()
vi.mock("@/hooks/use-channel-guard", () => ({ useChannelAlerts: () => ({ data: status() }) }))

const base = { enforced: true, locked: false, paused: false, warnings: [] as string[] }

describe("ChannelGuardBanner", () => {
  beforeEach(() => status.mockReset())

  it("không hiện gì khi không có cảnh báo hoặc bản cài một công ty", () => {
    status.mockReturnValue(base)
    const { container, rerender } = render(<ChannelGuardBanner />)
    expect(container).toBeEmptyDOMElement()
    status.mockReturnValue({ ...base, enforced: false, warnings: ["x"] })
    rerender(<ChannelGuardBanner />)
    expect(container).toBeEmptyDOMElement()
    status.mockReturnValue(undefined)
    rerender(<ChannelGuardBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it("hiện từng cảnh báo; khoá/tạm dừng dùng kiểu lỗi", () => {
    status.mockReturnValue({ ...base, warnings: ["Sắp hết hạn mức bài đăng hôm nay (9/10)."] })
    const { rerender } = render(<ChannelGuardBanner />)
    expect(screen.getByRole("alert").textContent).toContain("Sắp hết hạn mức bài đăng")
    expect(screen.getByRole("alert").className).not.toContain("text-destructive")
    status.mockReturnValue({ ...base, locked: true, warnings: ["Kênh gửi ra ngoài đang bị tạm khoá: nghi spam. Nhận tin vẫn chạy."] })
    rerender(<ChannelGuardBanner />)
    expect(screen.getByRole("alert").className).toContain("text-destructive")
  })
})
