import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { SocialComposer } from "../social-composer"

const state = vi.hoisted(() => ({ saveDraft: vi.fn() }))

vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useSocialPreview: () => ({ data: undefined, isFetching: false, isError: false }),
  useSocialMediaPreview: () => ({ url: null }),
  useQueueSlots: () => ({ data: [], isLoading: false, isSuccess: true }),
  useQueueNext: () => ({ data: [], isLoading: false, isSuccess: true }),
  useSocialAccounts: () => ({
    data: [
      { id: 3, network: "facebook", name: "Tiệm May Hoa Sen", avatar_url: null, status: "active", last_error: null },
      { id: 4, network: "facebook", name: "Hoa Sen Hà Nội", avatar_url: null, status: "reauth", last_error: null },
    ],
    isLoading: false,
  }),
  useSocialSnippets: () => ({ data: [], isLoading: false, isSuccess: true }),
  useSnippetMutations: () => ({ save: { isPending: false, mutate: vi.fn() }, remove: { isPending: false, mutate: vi.fn() } }),
  useSocialMutations: () => ({
    create: { isPending: false, mutateAsync: vi.fn() },
    createRecurrence: { isPending: false, mutateAsync: vi.fn() },
    saveDraft: { isPending: false, mutate: state.saveDraft, mutateAsync: vi.fn() },
    publishDraft: { isPending: false, mutateAsync: vi.fn() },
    setQueueSlots: { isPending: false, mutate: vi.fn() },
  }),
}))

describe("ô soạn điện thoại: toàn màn «✕ Bài mới · Tiếp»", () => {
  beforeEach(() => {
    state.saveDraft.mockReset()
  })

  it("chưa soạn gì: ✕ đóng ngay, không hỏi", () => {
    const onClose = vi.fn()
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: "Đóng, không đăng" }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Bỏ bài đang soạn?")).toBeNull()
  })

  it("đang soạn: ✕ hỏi; Tiếp tục soạn giữ nguyên, Bỏ bài mới đóng", () => {
    const onClose = vi.fn()
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText("Nội dung bài đăng"), { target: { value: "Áo dài mới" } })
    fireEvent.click(screen.getByRole("button", { name: "Đóng, không đăng" }))
    expect(screen.getByText("Bỏ bài đang soạn?")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục soạn" }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Đóng, không đăng" }))
    fireEvent.click(screen.getByRole("button", { name: "Bỏ bài" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("đang soạn: «Lưu nháp rồi đóng» lưu nháp, xong mới đóng", () => {
    const onClose = vi.fn()
    state.saveDraft.mockImplementation((_b: unknown, o: { onSuccess: (d: { id: number }) => void }) => o.onSuccess({ id: 1 }))
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText("Nội dung bài đăng"), { target: { value: "Áo dài mới" } })
    fireEvent.click(screen.getByRole("button", { name: "Đóng, không đăng" }))
    fireEvent.click(screen.getByRole("button", { name: "Lưu nháp rồi đóng" }))
    expect(state.saveDraft).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Tiếp ⇒ «Xem lại và đăng» có hai ô Ngày, Giờ khi chọn Hẹn giờ; Sửa quay lại", () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Nội dung bài đăng"), { target: { value: "Áo dài mới" } })
    fireEvent.click(screen.getByRole("checkbox", { name: /Tiệm May Hoa Sen/ }))
    fireEvent.click(screen.getByRole("button", { name: "Tiếp" }))
    expect(screen.getByRole("heading", { name: "Xem lại và đăng" })).toBeTruthy()
    fireEvent.click(screen.getByRole("radio", { name: "Hẹn giờ" }))
    expect(screen.getByLabelText("Ngày đăng")).toBeTruthy()
    expect(screen.getByLabelText("Giờ đăng")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Quay lại sửa bài" }))
    expect(screen.getByRole("heading", { name: "Bài mới" })).toBeTruthy()
  })

  it("Page cần liên kết lại ghi rõ ngay trong hàng", () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    expect(screen.getAllByText("Cần liên kết lại ở mục Kênh").length).toBeGreaterThan(0)
  })
})
