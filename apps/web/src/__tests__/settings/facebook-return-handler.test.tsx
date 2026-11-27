import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"

const replace = vi.fn()
const invalidate = vi.fn()
let search = ""
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }))
vi.mock("sonner", () => ({ toast }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/connections",
  useRouter: () => ({ replace }),
}))
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: invalidate }) }))

import { FacebookReturnHandler } from "@/components/facebook-return-handler"
import { FB_RETURN_KEY } from "@/app/(dashboard)/settings/_components/integrations/use-facebook"

beforeEach(() => {
  replace.mockClear(); invalidate.mockClear(); Object.values(toast).forEach((f) => f.mockClear()); sessionStorage.clear()
})

describe("<FacebookReturnHandler>", () => {
  it("kết nối xong ⇒ báo 'Đã kết nối N Page' và về đúng màn đã bấm", () => {
    sessionStorage.setItem(FB_RETURN_KEY, "/dashboard?x=1")
    search = "muc=facebook&facebook=connected&pages=3&failed=0&posting=3"
    render(<FacebookReturnHandler />)
    expect(toast.success).toHaveBeenCalledWith("Đã kết nối 3 Page")
    expect(replace).toHaveBeenCalledWith("/dashboard?x=1")
    expect(sessionStorage.getItem(FB_RETURN_KEY)).toBeNull()
  })

  it("lỗi thiếu quyền ⇒ câu tiếng Việt, vẫn về màn cũ", () => {
    sessionStorage.setItem(FB_RETURN_KEY, "/dashboard")
    search = "facebook=error&reason=permission"
    render(<FacebookReturnHandler />)
    expect(toast.error.mock.calls[0][0]).toMatch(/quản trị Page/)
    expect(replace).toHaveBeenCalledWith("/dashboard")
  })

  it("huỷ ⇒ thông báo nhẹ", () => {
    sessionStorage.setItem(FB_RETURN_KEY, "/dashboard")
    search = "facebook=cancelled"
    render(<FacebookReturnHandler />)
    expect(toast.message).toHaveBeenCalled()
  })

  it("không có màn đã nhớ, đang ở /connections hoặc đường dẫn ngoài ⇒ không chuyển, không báo (panel tự báo)", () => {
    search = "facebook=connected&pages=1"
    render(<FacebookReturnHandler />)
    sessionStorage.setItem(FB_RETURN_KEY, "//evil.example")
    render(<FacebookReturnHandler />)
    sessionStorage.setItem(FB_RETURN_KEY, "/connections?muc=facebook")
    render(<FacebookReturnHandler />)
    expect(replace).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
