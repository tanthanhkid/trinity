import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { PreviewCard, SocialPreviewPanel } from "../social-preview"
import type { SocialTargetPreview } from "@/hooks/use-social"

const hook = vi.hoisted(() => ({ calls: [] as Array<{ enabled: boolean }> }))
vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useSocialPreview: (_b: unknown, enabled: boolean) => {
    hook.calls.push({ enabled })
    return { data: undefined, isFetching: false, isError: false }
  },
}))

const base: SocialTargetPreview = {
  account_id: 1, account_name: "Fanpage", network: "facebook", text: "Xin chào", first_comment: null,
  length: 8, limit: 63206, truncated_at: null, media: [], warnings: [],
}

describe("PreviewCard", () => {
  it("chữ ngắn hiện đủ, không có nút Xem thêm; giữ xuống dòng", () => {
    const { container } = render(<PreviewCard p={{ ...base, text: "dòng 1\ndòng 2" }} />)
    expect(screen.queryByText("Xem thêm")).toBeNull()
    expect(container.querySelector("p.whitespace-pre-wrap")?.textContent).toBe("dòng 1\ndòng 2")
    expect(screen.getByText("Fanpage")).toBeTruthy()
  })

  it("gập tại truncated_at, bấm Xem thêm thì hiện đủ, Thu gọn thì gập lại", () => {
    const text = "a".repeat(10) + "TAIL"
    const { container } = render(<PreviewCard p={{ ...base, text, length: 14, truncated_at: 10 }} />)
    const body = () => container.querySelector("p.whitespace-pre-wrap")?.textContent ?? ""
    expect(body()).toContain("a".repeat(10) + "… ")
    expect(body()).not.toContain("TAIL")
    fireEvent.click(screen.getByText("Xem thêm"))
    expect(body()).toContain(text)
    fireEvent.click(screen.getByText("Thu gọn"))
    expect(body()).not.toContain("TAIL")
  })

  it("cảnh báo hiện màu đỏ; vượt giới hạn thì bộ đếm đỏ", () => {
    render(<PreviewCard p={{ ...base, length: 63300, limit: 63206, warnings: ["Facebook: cần ảnh hoặc video."] }} />)
    const w = screen.getByText("Facebook: cần ảnh hoặc video.")
    expect(w.closest("ul")?.className).toContain("text-destructive")
    expect(screen.getByText("63.300/63.206").className).toContain("text-destructive")
  })


  it("Facebook: bình luận đầu tiên dưới bài; ảnh/video dùng ô giữ chỗ khi không có renderMedia", () => {
    render(<PreviewCard p={{ ...base, first_comment: "Link mua hàng", media: [{ key: "a", type: "image" }, { key: "b", type: "video" }] }} />)
    expect(screen.getByTestId("preview-first-comment").textContent).toContain("Link mua hàng")
    expect(screen.getByText("Ảnh")).toBeTruthy()
  })
})

describe("SocialPreviewPanel", () => {
  it("chưa chọn kênh ⇒ nhắc chọn và không gọi máy chủ", () => {
    hook.calls.length = 0
    render(<SocialPreviewPanel body={{ content: "x", media_keys: [], targets: [] }} libIds={{}} />)
    expect(screen.getByText(/Chọn ít nhất một kênh/)).toBeTruthy()
    expect(hook.calls.every((c) => !c.enabled)).toBe(true)
  })

  it("đã chọn kênh ⇒ bật truy vấn", () => {
    hook.calls.length = 0
    render(<SocialPreviewPanel body={{ content: "x", media_keys: [], targets: [{ account_id: 1, caption: null }] }} libIds={{}} />)
    expect(hook.calls.some((c) => c.enabled)).toBe(true)
  })
})
