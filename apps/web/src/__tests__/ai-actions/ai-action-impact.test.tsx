/** đổi cấu trúc ảnh hưởng dữ liệu: hộp đỏ + phải gõ đúng tên bảng mới bấm Duyệt được; gửi confirm_text lên BE. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { AiAction } from "@/lib/ai-actions"

const approve = vi.fn()
vi.mock("@/hooks/ai-actions/use-ai-actions", () => ({
  useApproveAiAction: () => ({ mutate: approve, isPending: false, isError: false }),
  useRejectAiAction: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}))
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

import { AiActionDialog } from "@/app/(dashboard)/ai-actions/_components/ai-action-dialog"
import { confirmMatches } from "@/lib/ai-actions"

const ACTION: AiAction = {
  id: 5, tool: "archive_field", tool_label: "Ẩn trường", client_name: "ChatGPT", summary: "Ẩn trường Nguồn", details: [], status: "pending",
  result: null, error: null, created_at: "2026-10-07T10:00:00Z", decided_at: null, expires_at: "2026-10-08T10:00:00Z",
  impact: { affected_records: 42, confirm_label: "Khách hàng", lines: ["42 bản ghi của “Khách hàng” đang có dữ liệu ở trường “Nguồn”"], tables: [{ key: "khach_hang", label: "Khách hàng", records: 42 }] },
}

beforeEach(() => approve.mockClear())

describe("AiActionDialog — cảnh báo đổi cấu trúc", () => {
  it("hộp đỏ có số bản ghi; nút Duyệt khoá tới khi gõ đúng tên bảng", () => {
    render(<AiActionDialog action={ACTION} onClose={() => undefined} />)
    expect(screen.getByTestId("impact-box").textContent).toContain("42 bản ghi")
    const btn = screen.getByRole("button", { name: /Duyệt và thực hiện/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Gõ tên bảng/), { target: { value: "Khách mới" } })
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Gõ tên bảng/), { target: { value: " khách hàng " } })
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(approve).toHaveBeenCalledWith({ id: 5, confirmText: " khách hàng " }, expect.anything())
  })
  it("không có bản ghi bị ảnh hưởng ⇒ không bắt gõ tên", () => {
    render(<AiActionDialog action={{ ...ACTION, impact: { ...ACTION.impact!, affected_records: 0, confirm_label: null } }} onClose={() => undefined} />)
    expect(screen.queryByLabelText(/Gõ tên bảng/)).toBeNull()
    expect((screen.getByRole("button", { name: /Duyệt và thực hiện/ }) as HTMLButtonElement).disabled).toBe(false)
  })
  it("duyệt thành công ⇒ popup đóng (gọi onClose)", () => {
    approve.mockImplementation((_a: unknown, o: { onSuccess?: () => void }) => o.onSuccess?.())
    const onClose = vi.fn()
    render(<AiActionDialog action={{ ...ACTION, impact: null }} onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: /Duyệt và thực hiện/ }))
    expect(onClose).toHaveBeenCalledTimes(1)
    approve.mockReset()
  })
  it("confirmMatches giống luật BE", () => {
    expect(confirmMatches("  KHÁCH   hàng", "Khách hàng")).toBe(true)
    expect(confirmMatches("Khach hang", "Khách hàng")).toBe(false)
  })
})
