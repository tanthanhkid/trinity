import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { PostCard, htmlToPlain } from "@/app/(dashboard)/newsfeed/_components/post-card"
import type { NewsfeedPost } from "@/app/(dashboard)/newsfeed/_components/types"

const patch = vi.fn()
const post = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: {
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
    delete: vi.fn(),
    get: () => new Promise(() => {}),
  },
}))
vi.mock("@/store/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: number } }) => unknown) => sel({ user: { id: 1 } }),
}))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => false }) }))
vi.mock("@/app/(dashboard)/newsfeed/_components/use-is-desktop", () => ({ useIsDesktop: () => false }))
vi.mock("@/app/(dashboard)/newsfeed/_components/post-composer", async (orig) => ({
  ...(await orig<object>()),
  compressImage: async (f: File) => f,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }))

const base: NewsfeedPost = {
  id: 9,
  category: "announcement",
  author_id: 1,
  content: "<p>Ca sáng &amp; ca chiều</p>",
  image_url: null,
  images: [],
  edited_at: null,
  created_at: new Date().toISOString(),
  author: { id: 1, full_name: "Nguyễn Thị Mai", email: "mai@example.com", avatar_url: null },
  _count: { likes: 0, comments: 0 },
  liked_by_me: false,
}

function openEditor(p: NewsfeedPost = base) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <PostCard post={p} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getAllByRole("button", { name: "Thao tác với bài" })[1])
  fireEvent.click(screen.getByRole("button", { name: "Sửa bài" }))
  return screen.getByRole("dialog", { name: "Sửa bài" })
}

beforeEach(() => {
  patch.mockReset().mockResolvedValue({ data: {} })
  post.mockReset().mockResolvedValue({ data: {} })
})

describe("htmlToPlain", () => {
  it("bỏ thẻ, giải mã entity", () => {
    expect(htmlToPlain("<p>a &amp; b&nbsp;&lt;c&gt; &#39;d&#x27;</p>")).toBe("a & b <c> 'd'")
    expect(htmlToPlain("<p> </p>")).toBe("")
  })
})

describe("PostCard «Sửa bài» mobile", () => {
  it("đếm ký tự theo chữ thuần; Lưu tắt khi chưa đổi gì", () => {
    const dlg = openEditor()
    expect(screen.getByTestId("edit-char-count").textContent).toBe("18 ký tự")
    expect(dlg.querySelector("button[disabled]")?.textContent).toBe("Lưu")
  })

  it("đổi «Mục» làm Lưu sáng và gửi category qua PATCH", async () => {
    openEditor()
    const save = screen.getByRole("button", { name: "Lưu" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: "Đào tạo" }))
    expect(save.disabled).toBe(false)
    fireEvent.click(screen.getByRole("radio", { name: "Thông báo" }))
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: "Truyền thông" }))
    fireEvent.click(save)
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/newsfeed/9", { content: base.content, category: "pr" }),
    )
    expect(post).not.toHaveBeenCalled()
  })

  it("thêm ảnh thì lưu qua POST /newsfeed/:id/upload kèm nội dung", async () => {
    openEditor()
    const input = document.querySelector('input[type="file"][accept^="image"]') as HTMLInputElement
    const file = new File(["x"], "anh.png", { type: "image/png" })
    fireEvent.change(input, { target: { files: [file] } })
    expect(screen.getByText("anh.png")).toBeTruthy()
    const save = screen.getByRole("button", { name: "Lưu" }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(post).toHaveBeenCalled())
    const [url, fd] = post.mock.calls[0] as [string, FormData]
    expect(url).toBe("/newsfeed/9/upload")
    expect(fd.get("content")).toBe(base.content)
    expect(fd.get("category")).toBeNull()
    expect(fd.getAll("images")).toHaveLength(1)
    expect(patch).not.toHaveBeenCalled()
  })

  it("bài chỉ có ảnh (không chữ): đổi «Mục» vẫn lưu được, đi route multipart", async () => {
    const images = [{ id: 1, image_url: "k", media_type: "image" as const, sort_order: 0 }]
    openEditor({ ...base, content: "", images })
    const save = screen.getByRole("button", { name: "Lưu" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: "Đào tạo" }))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(post).toHaveBeenCalled())
    const [url, fd] = post.mock.calls[0] as [string, FormData]
    expect(url).toBe("/newsfeed/9/upload")
    expect(fd.get("category")).toBe("training")
    expect(patch).not.toHaveBeenCalled()
  })

  it("entity ngoài dải Unicode không làm vỡ màn", () => {
    expect(htmlToPlain("a&#99999999;b&#x110000;")).toBe("a&#99999999;b&#x110000;")
  })

  it("bài đã đủ 10 ảnh thì nút «Thêm ảnh» tắt", () => {
    const images = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      image_url: `k${i}`,
      media_type: "image" as const,
      sort_order: i,
    }))
    openEditor({ ...base, images })
    expect((screen.getByRole("button", { name: "Thêm ảnh" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Thêm video" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
