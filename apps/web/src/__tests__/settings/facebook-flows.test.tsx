import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/** Cài đặt > Fanpage > Kịch bản nhắn tin: danh sách kịch bản, dựng bước, xem trước, lượt chạy. */
const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a), patch: (...a: unknown[]) => mockPatch(...a), delete: vi.fn() },
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

import { toast } from "sonner"
import { FacebookFlows, flowProblem, newStepId } from "@/app/(dashboard)/settings/_components/integrations/facebook-flows"

const PAGE = { id: 1, page_id: "111", name: "Trinity Software", is_active: true } as never
const FLOW = {
  id: 7, name: "Hỏi học phí", page_id: "111", page_name: "Trinity Software", trigger: "keyword", keywords: ["học phí", "giá"], chat_link_id: null, chat_link_name: null,
  steps: [
    { id: "s1", text: "Chào {ten}!" },
    { id: "s2", text: "Bạn quan tâm khoá nào?", buttons: [{ title: "Trẻ em", next: "s3" }, { title: "Người lớn", next: null }] },
    { id: "s3", text: "Cho mình xin SĐT nhé", ask: "phone", wait_minutes: 5 },
  ],
  is_active: false, starts: 12, completes: 8, running: 2, updated_at: "2026-10-14T01:00:00.000Z",
}
const RUNS = [{ id: 1, flow_id: 7, conversation_id: 3, customer_name: "Lan", contact_id: 9, step_id: "s2", status: "waiting_button", due_at: null, note: null, started_at: "2026-10-14T02:00:00.000Z", updated_at: "2026-10-14T02:00:00.000Z" }]

function renderIt(flows: unknown[], highlight?: number) {
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/facebook/flows") return { data: { data: flows } }
    if (url.endsWith("/runs")) return { data: { data: RUNS } }
    return { data: { data: [] } }
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><FacebookFlows pages={[PAGE]} highlight={highlight} /></QueryClientProvider>)
}

describe("FacebookFlows", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("hàm thuần: mã bước mới không trùng; kiểm thiếu tên/từ khoá/nội dung/chữ nút", () => {
    expect(newStepId([{ id: "s1", text: "a" }, { id: "s3", text: "b" }])).toBe("s4")
    expect(newStepId([{ id: "s2", text: "a" }])).toBe("s3")
    expect(flowProblem("", "keyword", ["a"], "", [{ id: "s1", text: "x" }])).toMatch(/tên/)
    expect(flowProblem("A", "keyword", [], "", [{ id: "s1", text: "x" }])).toMatch(/từ khoá/)
    expect(flowProblem("A", "chat_link", [], "", [{ id: "s1", text: "x" }])).toMatch(/link/)
    expect(flowProblem("A", "first_message", [], "", [{ id: "s1", text: " " }])).toMatch(/Bước 1/)
    expect(flowProblem("A", "first_message", [], "", [{ id: "s1", text: "x", buttons: [{ title: "", next: null }] }])).toMatch(/nút/)
    expect(flowProblem("A", "first_message", [], "", [{ id: "s1", text: "x" }])).toBeNull()
  })

  it("thẻ kịch bản: cách bắt đầu, số bước, số lượt; tô sáng + mở sẵn lượt chạy khi được trỏ tới", async () => {
    renderIt([FLOW], 7)
    expect(await screen.findByText("Hỏi học phí")).toBeInTheDocument()
    const card = screen.getByTestId("flow-card")
    expect(card.textContent).toContain("Khách nhắn có từ khoá: học phí, giá")
    expect(card.textContent).toContain("3 bước")
    expect(card.textContent).toContain("12 lượt chạy · 8 đi hết · 2 đang dở")
    expect(card.className).toContain("ring-2")
    expect(await screen.findByTestId("flow-runs")).toHaveTextContent("Lan")
    expect(screen.getByTestId("flow-runs")).toHaveTextContent("Chờ khách bấm nút")
  })

  it("bật kịch bản gửi PATCH is_active", async () => {
    renderIt([FLOW])
    mockPatch.mockResolvedValue({ data: { ...FLOW, is_active: true } })
    fireEvent.click(await screen.findByRole("switch", { name: "Bật kịch bản Hỏi học phí" }))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/facebook/flows/7", { is_active: true }))
  })

  it("sửa: mở đủ bước, xem trước thay {ten}, nút hiện thành chip, có dòng chờ", async () => {
    renderIt([FLOW])
    fireEvent.click(await screen.findByRole("button", { name: /Sửa/ }))
    expect(await screen.findAllByTestId("flow-step")).toHaveLength(3)
    const preview = screen.getByLabelText("Xem trước kịch bản")
    expect(preview.textContent).toContain("Chào Lan!")
    expect(preview.textContent).toContain("Trẻ em")
    expect(preview.textContent).toContain("chờ 5 phút")
    expect(preview.textContent).toContain("lưu số điện thoại")
  })

  it("tạo: thiếu từ khoá thì báo lỗi; đủ thì gửi đúng thân (một Page tự chọn, bước thêm có mã s2)", async () => {
    renderIt([])
    expect(await screen.findByText("Chưa có kịch bản nhắn tin nào.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Tạo kịch bản/ }))
    fireEvent.change(screen.getByLabelText("Tên kịch bản"), { target: { value: "Chào khách" } })
    fireEvent.change(screen.getByLabelText("Nội dung tin"), { target: { value: "Xin chào {ten}" } })
    fireEvent.click(screen.getByRole("button", { name: /^Tạo kịch bản$/ }))
    expect(toast.error).toHaveBeenCalledWith("Nhập ít nhất một từ khoá")
    fireEvent.change(screen.getByLabelText(/Từ khoá/), { target: { value: "giá, học phí" } })
    fireEvent.click(screen.getByRole("button", { name: /Thêm bước/ }))
    fireEvent.change(screen.getAllByLabelText("Nội dung tin")[1], { target: { value: "Bạn cần tư vấn gì?" } })
    mockPost.mockResolvedValue({ data: FLOW })
    fireEvent.click(screen.getByRole("button", { name: /^Tạo kịch bản$/ }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/facebook/flows", {
        name: "Chào khách",
        page_id: "111",
        trigger: "keyword",
        keywords: ["giá", "học phí"],
        chat_link_id: null,
        steps: [{ id: "s1", text: "Xin chào {ten}" }, { id: "s2", text: "Bạn cần tư vấn gì?" }],
      }),
    )
  })
})
