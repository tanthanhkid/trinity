import { beforeEach, describe, expect, it, vi } from "vitest"

const get = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => get(...a) } }))
vi.mock("@/lib/token-storage", () => ({ getAccessToken: () => token }))

let token: string | null = "t1"
import { fromBootstrap, resetBootstrapForTests } from "@/lib/bootstrap"

beforeEach(() => {
  get.mockReset()
  resetBootstrapForTests()
  token = "t1"
})

describe("fromBootstrap", () => {
  it("nhiều queryFn dùng chung MỘT lượt /bootstrap và mỗi khoá lấy một lần", async () => {
    get.mockResolvedValue({ data: { pinned_menu: { keys: ["a"] }, unread_message: { count: 3 } } })
    const fb = vi.fn(async () => "net")
    const [a, b, c] = await Promise.all([
      fromBootstrap("pinned_menu", fb),
      fromBootstrap<number>("unread_message", fb as never, (r) => (r as { count: number }).count),
      fromBootstrap("org_features", fb), // khoá vắng ⇒ gọi endpoint gốc
    ])
    expect(get).toHaveBeenCalledTimes(1)
    expect(a).toEqual({ keys: ["a"] })
    expect(b).toBe(3)
    expect(c).toBe("net")
    // Lần thứ hai cùng khoá (refetch/poll) đi thẳng endpoint gốc.
    expect(await fromBootstrap("pinned_menu", fb)).toBe("net")
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("phần null ⇒ fallback; pick trả undefined ⇒ fallback", async () => {
    get.mockResolvedValue({ me: null, unread_profile: { bad: 1 } })
    const fb = vi.fn(async () => 7)
    expect(await fromBootstrap("me", fb)).toBe(7)
    expect(await fromBootstrap<number>("unread_profile", fb, () => undefined)).toBe(7)
  })

  it("bootstrap lỗi (máy chủ cũ 404) ⇒ fallback và không gọi lại trong lúc nghỉ", async () => {
    get.mockRejectedValue(new Error("404"))
    const fb = vi.fn(async () => "net")
    expect(await fromBootstrap("me", fb)).toBe("net")
    expect(await fromBootstrap("pinned_menu", fb)).toBe("net")
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("chưa đăng nhập ⇒ không gọi /bootstrap", async () => {
    token = null
    const fb = vi.fn(async () => "net")
    expect(await fromBootstrap("me", fb)).toBe("net")
    expect(get).not.toHaveBeenCalled()
  })

  it("trang khác /dashboard không xin phần Tổng quan", async () => {
    get.mockResolvedValue({})
    await fromBootstrap("me", async () => 1)
    expect(get.mock.calls[0][0]).toBe("/bootstrap")
  })
})
