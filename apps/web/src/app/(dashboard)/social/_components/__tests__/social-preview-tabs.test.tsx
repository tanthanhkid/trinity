import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { SocialPreviewPanel } from "../social-preview"
import type { SocialTargetPreview } from "@/hooks/use-social"

const mk = (id: number, name: string): SocialTargetPreview => ({
  account_id: id, account_name: name, network: "facebook", text: `Bài của ${name}`, first_comment: null,
  length: 10, limit: 63206, truncated_at: null, media: [], warnings: [],
})
const state = vi.hoisted(() => ({ targets: [] as unknown[] }))
vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useSocialPreview: () => ({ data: { targets: state.targets, warnings: [], scheduled_at: null, from_queue: false }, isFetching: false, isError: false }),
}))

const body = { content: "x", media_keys: [], targets: [{ account_id: 1, caption: null }, { account_id: 2, caption: null }] }

describe("SocialPreviewPanel — tab theo từng Page", () => {
  it("một Page: không có tab, hiện thẻ xem trước", () => {
    state.targets = [mk(1, "Tiệm May Hoa Sen")]
    render(<SocialPreviewPanel body={{ ...body, targets: body.targets.slice(0, 1) }} libIds={{}} />)
    expect(screen.queryByRole("tablist")).toBeNull()
    expect(screen.getByText("Bài của Tiệm May Hoa Sen")).toBeTruthy()
  })

  it("hai Page: mỗi lúc một thẻ, đổi tab đổi thẻ", () => {
    state.targets = [mk(1, "Tiệm May Hoa Sen"), mk(2, "Hoa Sen Outlet")]
    render(<SocialPreviewPanel body={body} libIds={{}} />)
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((t) => t.textContent)).toEqual(["Tiệm May Hoa Sen", "Hoa Sen Outlet"])
    expect(tabs[0].getAttribute("aria-selected")).toBe("true")
    expect(screen.getByText("Bài của Tiệm May Hoa Sen")).toBeTruthy()
    expect(screen.queryByText("Bài của Hoa Sen Outlet")).toBeNull()
    fireEvent.click(tabs[1])
    expect(screen.getByText("Bài của Hoa Sen Outlet")).toBeTruthy()
    expect(screen.queryByText("Bài của Tiệm May Hoa Sen")).toBeNull()
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe("true")
  })
})
