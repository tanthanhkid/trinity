/**
 * Giao diện mới (bước 3): khối bộ lọc 2 hàng → nút "Lọc" mở popover. Popover phải GIỮ ĐỦ mọi điều kiện cũ,
 * nút "Lọc" đếm đúng số điều kiện đang áp, chip điều kiện vẫn gỡ được. Cột "Tín hiệu" chỉ từ dữ liệu thật.
 */
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import type { ComponentProps } from "react"

vi.mock("@/hooks/use-settings-options", () => ({
  useSettingsOptions: (type: string) => ({
    data: type === "contact_stage" ? [{ id: 1, value: "new", label: "Mới" }] : type === "contact_source" ? [{ id: 2, value: "zalo", label: "Zalo" }] : [],
  }),
}))
vi.mock("@/hooks/use-projects", () => ({ useActiveProjects: () => ({ data: [{ id: 9, name: "Dự án A" }], isLoading: false }) }))
vi.mock("@/hooks/use-contact-assignable-users", () => ({
  useContactAssignableUsers: () => ({ data: [{ id: 7, full_name: "Sale Bảy", email: "s7@x.vn" }], isLoading: false }),
}))
vi.mock("@/lib/api-client", () => ({ default: { get: vi.fn() } }))

import { ContactsFilters } from "@/app/(dashboard)/contacts/_components/contacts-filters"
import { contactSignals, latestAiActionByContact } from "@/app/(dashboard)/contacts/_components/contact-signals"
import type { AiAction } from "@/lib/ai-actions"

type Props = ComponentProps<typeof ContactsFilters>

function setup(over: Partial<Props> = {}) {
  const props: Props = {
    searchInput: "",
    onSearch: vi.fn(),
    onFilterChange: () => vi.fn(),
    onApply: vi.fn(),
    onReset: vi.fn(),
    onRemoveApplied: vi.fn(),
    ...over,
  }
  render(<ContactsFilters {...props} />)
  return props
}

describe("Popover 'Lọc' — giữ đủ điều kiện cũ", () => {
  it("mở popover thấy ĐỦ 8 điều kiện: giai đoạn, trạng thái chi tiết, nguồn, điểm lead, dự án, phụ trách, từ ngày, đến ngày", () => {
    setup({ showLeadFilter: true, showAssigneeFilter: true })
    fireEvent.click(screen.getByRole("button", { name: "Lọc" }))
    const pop = screen.getByRole("dialog")
    for (const label of ["Giai đoạn", "Trạng thái chi tiết", "Nguồn", "Điểm lead", "Dự án", "Phụ trách", "Khoảng ngày tạo"]) {
      expect(within(pop).getByText(label)).toBeInTheDocument()
    }
    expect(within(pop).getByLabelText("Từ ngày")).toBeInTheDocument()
    expect(within(pop).getByLabelText("Đến ngày")).toBeInTheDocument()
    expect(within(pop).getByRole("button", { name: "Áp dụng bộ lọc" })).toBeInTheDocument()
    expect(within(pop).getByRole("button", { name: "Đặt lại bộ lọc" })).toBeInTheDocument()
  })

  it("tắt lead_scoring / phạm vi own ⇒ popover không có Điểm lead / Phụ trách (như khối lọc cũ)", () => {
    setup({ showLeadFilter: false, showAssigneeFilter: false })
    fireEvent.click(screen.getByRole("button", { name: "Lọc" }))
    const pop = screen.getByRole("dialog")
    expect(within(pop).queryByText("Điểm lead")).toBeNull()
    expect(within(pop).queryByText("Phụ trách")).toBeNull()
    expect(within(pop).getByText("Giai đoạn")).toBeInTheDocument()
  })

  it("nút 'Lọc' đếm số điều kiện ĐANG ÁP (không tính từ khoá tìm); chip vẫn hiện và gỡ được", () => {
    const props = setup({
      showAssigneeFilter: true,
      applied: { stageId: "1", sourceId: "2", assignedTo: "7", createdFrom: "2026-10-01", search: "lan" },
    })
    expect(screen.getByRole("button", { name: "Lọc — 4 điều kiện đang bật" })).toBeInTheDocument()
    expect(screen.getByTestId("filter-count")).toHaveTextContent("4")
    for (const chip of ["Giai đoạn: Mới", "Nguồn: Zalo", "Phụ trách: Sale Bảy", "Từ ngày: 01/10/2026", 'Tìm: "lan"']) {
      expect(screen.getByText(chip)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole("button", { name: "Bỏ điều kiện Nguồn: Zalo" }))
    expect(props.onRemoveApplied).toHaveBeenCalledWith("sourceId")
  })

  it("Áp dụng trong popover gọi onApply; Enter ở ô tìm cũng áp", () => {
    const props = setup()
    fireEvent.click(screen.getByRole("button", { name: "Lọc" }))
    fireEvent.click(screen.getByRole("button", { name: "Áp dụng bộ lọc" }))
    expect(props.onApply).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByLabelText("Tìm khách hàng"), { key: "Enter" })
    expect(props.onApply).toHaveBeenCalledTimes(2)
  })
})

const ai = (over: Partial<AiAction>): AiAction => ({
  id: 1, tool: "create_contact", tool_label: "Tạo khách hàng", client_name: "ChatGPT", summary: "Tạo khách hàng A",
  details: [], status: "executed", result: { contact_id: 5 }, error: null, created_at: "2026-10-12T02:42:00Z",
  decided_at: null, expires_at: "2026-10-13T02:42:00Z", ...over,
})

describe("Cột Tín hiệu — chỉ từ dữ liệu thật", () => {
  it("gom hoạt động AI có hiệu lực theo khách, lấy cái mới nhất; bỏ chờ duyệt/lỗi/không có contact_id", () => {
    const map = latestAiActionByContact([
      ai({ id: 1 }),
      ai({ id: 2, tool: "add_contact_note", created_at: "2026-10-12T03:00:00Z" }),
      ai({ id: 3, status: "pending", created_at: "2026-10-12T04:00:00Z" }),
      ai({ id: 4, status: "failed", result: { contact_id: 6 } }),
      ai({ id: 5, result: null }),
    ])
    expect([...map.keys()]).toEqual(["5"])
    expect(map.get("5")?.id).toBe(2)
  })

  it("chip AI (giờ VN hôm nay), thương vụ, nguồn; không có dữ liệu ⇒ không chip", () => {
    const c = { id: "5", source: { id: 2, value: "zalo", label: "Zalo" }, latest_deal: { id: 3, title: "Hoa cưới", status: "open" as const, creator_name: null, creator_email: null } }
    const s = contactSignals(c, ai({}), "2026-10-12")
    expect(s.map((x) => x.text)).toEqual(["AI thêm 09:42", "Thương vụ: Hoa cưới", "Từ Zalo"])
    expect(s[0]).toMatchObject({ tone: "ai", href: "/ai-actions?id=1" })
    expect(contactSignals({ id: "6", source: null, latest_deal: null }, undefined, "2026-10-12")).toEqual([])
    expect(contactSignals(c, ai({}), "2026-10-13")[0].text).toBe("AI thêm 12/10")
  })
})
