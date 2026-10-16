/**
 * Đầu trang Tổng quan "AI Native": trợ lý AI đang làm việc + kênh đã kết nối.
 * Kiểm: chưa nối AI ⇒ lời mời nổi bật dẫn tới màn Kết nối; có trợ lý ⇒ logo/tên/lần dùng; kênh có trạng thái + số hôm nay;
 * không chữ "MCP" trên giao diện.
 */
import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

import type { AiConnection } from "@/app/(dashboard)/settings/_components/integrations/integrations-meta"
import { CONNECT_AI_HREF } from "@/app/(dashboard)/dashboard/_components/home-ai-timeline"
import { AiAssistantsHub, ChannelsHub } from "@/app/(dashboard)/dashboard/_components/home-ai-hub"

const conn = (over: Partial<AiConnection> = {}): AiConnection => ({
  id: "c1", client_id: "x", client_name: "Claude", client_kind: "dcr", user: { id: 1, full_name: "Lan", email: "lan@x.vn" },
  scopes: ["crm.read", "crm.write"], connected_at: "2026-10-12T01:00:00Z", last_used_at: null, refresh_expires_at: "2026-11-12T01:00:00Z", ...over,
})
const NOW = Date.parse("2026-10-16T03:00:00Z")

describe("AiAssistantsHub", () => {
  it("chưa nối trợ lý nào ⇒ lời mời kết nối nổi bật, 3 bước, nút tới màn Kết nối", () => {
    const { container } = render(<AiAssistantsHub state="ready" rows={[]} showOwner={false} doneToday={null} now={NOW} />)
    const invite = screen.getByTestId("hub-ai-invite")
    expect(within(invite).getByRole("link", { name: /Kết nối trợ lý AI/ })).toHaveAttribute("href", CONNECT_AI_HREF)
    expect(invite.querySelectorAll("ol li")).toHaveLength(3)
    expect(container.textContent).not.toMatch(/MCP/)
  })

  it("có trợ lý ⇒ số việc hôm nay, tên (+ người), 'Đang hoạt động' khi vừa dùng, 'Chưa dùng' khi chưa", () => {
    render(
      <AiAssistantsHub
        state="ready"
        showOwner
        doneToday="4 việc"
        now={NOW}
        rows={[conn({ last_used_at: "2026-10-16T02:55:00Z" }), conn({ id: "c2", client_name: "ChatGPT" })]}
      />,
    )
    const list = screen.getByTestId("hub-ai-list")
    expect(list.textContent).toContain("Claude · Lan")
    expect(list.textContent).toContain("Đang hoạt động")
    expect(list.textContent).toContain("Chưa dùng")
    expect(screen.getByText("4 việc")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Xem AI đã làm gì" })).toHaveAttribute("href", "/ai-actions")
  })

  it("không có quyền ⇒ nói rõ, không lời mời", () => {
    render(<AiAssistantsHub state="no-permission" rows={[]} showOwner={false} doneToday={null} now={NOW} />)
    expect(screen.getByTestId("hub-ai-no-permission")).toBeInTheDocument()
    expect(screen.queryByTestId("hub-ai-invite")).toBeNull()
  })
})

describe("ChannelsHub", () => {
  it("kênh có trạng thái + số hôm nay; kênh chưa nối ⇒ nút 'Nối …'", () => {
    render(
      <ChannelsHub
        loading={false}
        error={false}
        data={{
          channels: [
            { key: "facebook_page:1", kind: "facebook_page", network: "facebook", name: "AiiLab", state: "ok", note: "Đang nhận tin", today: { label: "tin nhắn mới", value: 5 }, href: "/settings?tab=integrations&muc=facebook" },
            { key: "facebook_page:2", kind: "facebook_page", network: "facebook", name: "Trinity", state: "off", note: "Đã tắt", today: { label: "tin nhắn mới", value: 0 }, href: "/settings?tab=integrations&muc=facebook" },
          ],
          available: [{ kind: "zalo_oa", label: "Zalo OA", href: "/settings?tab=integrations&muc=zalo-oa" }],
        }}
      />,
    )
    const list = screen.getByTestId("channels")
    expect(list.textContent).toContain("AiiLab")
    expect(list.textContent).toContain("Đã tắt")
    expect(screen.getByText("1/2 đang chạy")).toBeInTheDocument()
    expect(within(screen.getByTestId("channels-available")).getByRole("link", { name: /Nối Zalo OA/ })).toHaveAttribute("href", "/settings?tab=integrations&muc=zalo-oa")
  })

  it("chưa bật kênh nào ⇒ dẫn tới Cài đặt › Tính năng", () => {
    render(<ChannelsHub loading={false} error={false} data={{ channels: [], available: [] }} />)
    expect(within(screen.getByTestId("channels-empty")).getByRole("link")).toHaveAttribute("href", "/settings?tab=features")
  })
})

describe("groupPostingChannels", () => {
  it("gộp kênh đăng bài cùng mạng thành một dòng, cộng số bài, trạng thái xấu nhất", async () => {
    const { groupPostingChannels } = await import("@/app/(dashboard)/dashboard/_components/home-ai-hub")
    const post = (id: number, name: string, state: "ok" | "attention", n: number) => ({ key: `social:${id}`, kind: "social" as const, network: "facebook", name, state, note: "", today: { label: "bài đã đăng", value: n }, href: "/social?tab=channels" })
    const out = groupPostingChannels([
      post(1, "A", "ok", 1), post(2, "B", "attention", 2),
      { key: "facebook_page:1", kind: "facebook_page", network: "facebook", name: "A", state: "ok", note: "Đang nhận tin", today: null, href: "/x" },
      { key: "social:9", kind: "social", network: "youtube", name: "YT", state: "ok", note: "", today: { label: "bài đã đăng", value: 0 }, href: "/social?tab=channels" },
    ])
    expect(out.map((c) => c.key)).toEqual(["facebook_page:1", "social:facebook", "social:9"])
    expect(out[1]).toMatchObject({ name: "Đăng bài · 2 Fanpage", state: "attention", note: "1 kênh cần liên kết lại", today: { value: 3 } })
  })
})

describe("Logo chính thức", () => {
  it("kênh có hãng ⇒ logo chính thức (không chữ viết tắt); ô kết nối Cài đặt cũng vậy", async () => {
    const { ChannelMark } = await import("@/app/(dashboard)/dashboard/_components/home-ai-hub")
    const { ConnectionLogo } = await import("@/components/ui/connection-row")
    const { container } = render(<div><ChannelMark c={{ kind: "payment", network: "sepay" }} /><ChannelMark c={{ kind: "social", network: "youtube" }} /><ConnectionLogo brand="kiotviet" color="#000" text="K" /></div>)
    const imgs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))
    expect(imgs).toEqual(["/brand/logos/sepay.png", "/brand/logos/youtube.svg", "/brand/logos/kiotviet.png"])
    expect(container.textContent).not.toMatch(/\bK\b/)
  })
})
