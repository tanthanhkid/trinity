/**
 * Trang chủ "AI đã làm gì hôm nay": dòng thời gian, Cần bạn xem, Trợ lý đang kết nối.
 * Kiểm: trạng thái trống (không số giả, dẫn tới màn Kết nối sẵn có), KHÔNG hiện "Hoàn tác" khi app chưa có thao tác
 * hoàn tác thật, logo theo tên client, lọc "hôm nay" theo giờ VN.
 */
import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

import type { AiAction } from "@/lib/ai-actions"
import type { AiConnection } from "@/app/(dashboard)/settings/_components/integrations/integrations-meta"
import { AiTimelineView, CONNECT_AI_HREF } from "@/app/(dashboard)/dashboard/_components/home-ai-timeline"
import { ConnectedAssistantsView, NeedsReviewView } from "@/app/(dashboard)/dashboard/_components/home-side"
import {
  aiClientKind,
  agoLabel,
  canUndoAiAction,
  formatMoneyCompact,
  homeSummary,
  todaysAiActions,
} from "@/app/(dashboard)/dashboard/_components/home-utils"

const action = (over: Partial<AiAction> = {}): AiAction => ({
  id: 7,
  tool: "create_contact",
  tool_label: "Tạo khách hàng",
  client_name: "ChatGPT",
  summary: "Tạo khách Nguyễn Văn A",
  details: [],
  status: "executed",
  result: { contact_id: 12 },
  error: null,
  created_at: "2026-10-12T02:42:00Z",
  decided_at: "2026-10-12T02:42:00Z",
  expires_at: "2026-10-19T02:42:00Z",
  ...over,
})

const conn = (over: Partial<AiConnection> = {}): AiConnection => ({
  id: "c1",
  client_id: "x",
  client_name: "Claude",
  client_kind: "dcr",
  user: { id: 1, full_name: "Lan", email: "lan@x.vn" },
  scopes: ["crm.read", "crm.write"],
  connected_at: "2026-10-12T01:00:00Z",
  last_used_at: null,
  refresh_expires_at: "2026-11-12T01:00:00Z",
  ...over,
})

describe("AiTimelineView — dòng thời gian", () => {
  it("hiện giờ VN, việc, '<trợ lý> của <người>', logo đúng hãng, nút Xem dẫn tới đúng mục", () => {
    render(<AiTimelineView state="ready" rows={[action()]} userName="Thành" canConnect hasConnections />)
    const list = screen.getByTestId("ai-timeline")
    expect(within(list).getByText("09:42")).toBeInTheDocument()
    expect(within(list).getByText("Tạo khách Nguyễn Văn A")).toBeInTheDocument()
    expect(list.textContent).toContain("ChatGPT của Thành")
    expect(list.querySelector('[data-ai-kind="chatgpt"] img')?.getAttribute("src")).toBe("/brand/ai/chatgpt.svg")
    expect(within(list).getByRole("link", { name: /Xem chi tiết/ })).toHaveAttribute("href", "/ai-actions?id=7")
  })

  it("KHÔNG hiện 'Hoàn tác' — BE chưa có thao tác hoàn tác cho hành động AI", () => {
    const rows = [action(), action({ id: 8, tool: "update_object", status: "approved" }), action({ id: 9, status: "failed", error: "x" })]
    for (const r of rows) expect(canUndoAiAction(r)).toBe(false)
    render(<AiTimelineView state="ready" rows={rows} userName="Thành" canConnect hasConnections />)
    expect(screen.queryByText("Hoàn tác")).toBeNull()
    expect(screen.getAllByRole("link", { name: /Xem chi tiết/ })).toHaveLength(3)
    expect(screen.getByText(/Không thực hiện được/)).toBeInTheDocument()
  })

  it("trống + chưa kết nối trợ lý nào → hướng dẫn ngắn và nút 'Kết nối AI' tới màn Kết nối sẵn có, không số giả", () => {
    render(<AiTimelineView state="ready" rows={[]} userName="Thành" canConnect hasConnections={false} />)
    const empty = screen.getByTestId("ai-timeline-empty")
    expect(within(empty).getByRole("link", { name: "Kết nối AI" })).toHaveAttribute("href", CONNECT_AI_HREF)
    expect(CONNECT_AI_HREF).toBe("/settings?tab=integrations&muc=ai")
    expect(screen.queryByTestId("ai-timeline")).toBeNull()
    expect(empty.textContent).not.toMatch(/\d/)
  })

  it("trống nhưng đã có trợ lý kết nối → không mời kết nối lại", () => {
    render(<AiTimelineView state="ready" rows={[]} userName="Thành" canConnect hasConnections />)
    expect(screen.queryByRole("link", { name: "Kết nối AI" })).toBeNull()
    expect(screen.getByTestId("ai-timeline-empty").textContent).toMatch(/chưa làm việc nào/)
  })

  it("Kết nối AI tắt trên máy chủ (404) → báo rõ, không có danh sách", () => {
    render(<AiTimelineView state="disabled" rows={[]} userName="Thành" canConnect hasConnections={false} />)
    expect(screen.getByTestId("ai-timeline-disabled")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Kết nối AI" })).toBeNull()
  })
})

describe("ConnectedAssistantsView — trợ lý đang kết nối", () => {
  it("trống → 'Chưa có trợ lý nào kết nối' + nút Kết nối AI", () => {
    render(<ConnectedAssistantsView state="ready" rows={[]} showOwner={false} />)
    const empty = screen.getByTestId("connections-empty")
    expect(empty.textContent).toMatch(/Chưa có trợ lý nào kết nối/)
    expect(within(empty).getByRole("link", { name: "Kết nối AI" })).toHaveAttribute("href", CONNECT_AI_HREF)
  })

  it("không có quyền kết nối AI → nói rõ, không gọi/không hiện danh sách", () => {
    render(<ConnectedAssistantsView state="no-permission" rows={[]} showOwner={false} />)
    expect(screen.getByTestId("connections-no-permission")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Kết nối AI" })).toBeNull()
  })

  it("có dữ liệu → tên client (+ người khi xem cả công ty), logo theo tên, 'Chưa dùng' khi chưa có lần dùng", () => {
    render(<ConnectedAssistantsView state="ready" rows={[conn(), conn({ id: "c2", client_name: "Trợ lý nội bộ" })]} showOwner />)
    const list = screen.getByTestId("connections")
    expect(list.textContent).toContain("Claude · Lan")
    expect(list.querySelector('[data-ai-kind="claude"]')).not.toBeNull()
    expect(list.querySelector('[data-ai-kind="other"]')).not.toBeNull()
    expect(screen.getAllByText("Chưa dùng")).toHaveLength(2)
  })
})

describe("NeedsReviewView — cần bạn xem", () => {
  it("trống → câu 'Không có gì cần bạn xem', không mục nào", () => {
    render(<NeedsReviewView loading={false} items={[]} total={0} />)
    expect(screen.getByTestId("need-review-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("need-review")).toBeNull()
  })

  it("mục không có link an toàn → không vẽ nút", () => {
    render(
      <NeedsReviewView
        loading={false}
        total={2}
        items={[
          { key: "a", dot: "wait", title: "Duyệt đề xuất", sub: "ChatGPT đề xuất", href: "/ai-actions?id=3", cta: "Duyệt" },
          { key: "b", dot: "unread", title: "Thông báo", sub: "", href: null, cta: "Mở" },
        ]}
      />,
    )
    expect(screen.getByRole("link", { name: /Duyệt: Duyệt đề xuất/ })).toHaveAttribute("href", "/ai-actions?id=3")
    expect(screen.queryByRole("link", { name: /Mở: Thông báo/ })).toBeNull()
  })
})

describe("home-utils", () => {
  it("nhận diện trợ lý theo tên client", () => {
    expect(aiClientKind("ChatGPT")).toBe("chatgpt")
    expect(aiClientKind("OpenAI connector")).toBe("chatgpt")
    expect(aiClientKind("claude.ai")).toBe("claude")
    expect(aiClientKind("Google Gemini")).toBe("gemini")
    expect(aiClientKind("Cursor")).toBe("other")
    expect(aiClientKind(null)).toBe("other")
  })

  it("lọc hoạt động HÔM NAY theo giờ VN và bỏ đề xuất đang chờ duyệt", () => {
    const rows = [
      action({ id: 1, created_at: "2026-10-11T17:30:00Z" }), // 00:30 ngày 12 giờ VN → hôm nay
      action({ id: 2, created_at: "2026-10-11T16:30:00Z" }), // 23:30 ngày 11 giờ VN → hôm qua
      action({ id: 3, status: "pending" }),
    ]
    expect(todaysAiActions(rows, "2026-10-12").map((a) => a.id)).toEqual([1])
  })

  it("câu tóm tắt chỉ nói phần đã có số", () => {
    expect(homeSummary(3, 2)).toBe("Hôm nay các trợ lý AI đã làm 3 việc cho bạn. Có 2 chỗ cần bạn xem.")
    expect(homeSummary(0, 0)).toBe("Hôm nay các trợ lý AI chưa làm việc nào cho bạn. Không có gì cần bạn xem lúc này.")
    expect(homeSummary(null, null)).toBe("")
  })

  it("tiền gọn và nhãn thời gian", () => {
    expect(formatMoneyCompact(6_400_000)).toBe("6,4 triệu")
    expect(formatMoneyCompact(1_250_000_000)).toBe("1,3 tỷ")
    expect(formatMoneyCompact(500_000)).toMatch(/^500\.000 ₫$/)
    expect(agoLabel("5 phút")).toBe("5 phút trước")
    expect(agoLabel("Vừa xong")).toBe("Vừa xong")
  })
})
