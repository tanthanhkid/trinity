import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { SocialMetricsLine } from "../social-metrics"

describe("bài đã bị xoá trên kênh", () => {
  it("chưa từng có số ⇒ vẫn hiện trạng thái thay vì để trống", () => {
    render(<SocialMetricsLine metrics={{ views: null, reactions: null, comments: null, shares: null, removed: true }} network="youtube" />)
    expect(screen.getByTestId("social-metrics")).toHaveTextContent("Bài đã bị xoá trên kênh")
  })
  it("có số lần lấy cuối ⇒ hiện cả trạng thái lẫn số", () => {
    render(<SocialMetricsLine metrics={{ views: 40, reactions: 2, comments: 0, shares: null, removed: true }} network="youtube" />)
    const line = screen.getByTestId("social-metrics")
    expect(line).toHaveTextContent("Bài đã bị xoá trên kênh")
    expect(line).toHaveTextContent("40")
  })
})
