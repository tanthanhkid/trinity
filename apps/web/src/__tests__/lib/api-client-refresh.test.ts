import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock axios TRƯỚC khi import api-client. refreshTokens dùng `axios.post` (default)
// + `axios.isAxiosError`; api-client khởi tạo bằng `axios.create`.
const postMock = vi.fn()
vi.mock("axios", () => {
  const isAxiosError = (e: unknown): boolean =>
    typeof e === "object" &&
    e !== null &&
    (e as { isAxiosError?: boolean }).isAxiosError === true
  const instance = {
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    post: vi.fn(),
    get: vi.fn(),
  }
  return {
    default: {
      create: () => instance,
      post: (...args: unknown[]) => postMock(...args),
      isAxiosError,
    },
    isAxiosError,
  }
})

import { refreshTokens } from "@/lib/api-client"

function axiosError(status?: number): Error {
  const err = new Error(`AxiosError ${status ?? "network"}`) as Error & {
    isAxiosError: boolean
    response?: { status: number }
  }
  err.isAxiosError = true
  if (status) err.response = { status }
  return err
}

// Fix #1: trục trặc TẠM THỜI (mất mạng / 5xx) KHÔNG được đá user ra /login —
// phải retry; chỉ logout khi refresh token THẬT SỰ hết hạn (401/403).
describe("refreshTokens — không đăng xuất vì lỗi tạm thời", () => {
  beforeEach(() => postMock.mockReset())

  it("retry khi gặp 5xx rồi thành công", async () => {
    postMock
      .mockRejectedValueOnce(axiosError(503))
      .mockResolvedValueOnce({ data: { accessToken: "A", refreshToken: "R" } })
    const data = await refreshTokens("rt")
    expect(data.accessToken).toBe("A")
    expect(postMock).toHaveBeenCalledTimes(2)
  })

  it("retry khi mất mạng (không có response) rồi thành công", async () => {
    postMock
      .mockRejectedValueOnce(axiosError(undefined))
      .mockResolvedValueOnce({ data: { accessToken: "A2", refreshToken: "R2" } })
    const data = await refreshTokens("rt")
    expect(data.accessToken).toBe("A2")
    expect(postMock).toHaveBeenCalledTimes(2)
  })

  it("KHÔNG retry khi refresh token hết hạn (401) → ném ngay lần đầu", async () => {
    postMock.mockImplementationOnce(() => Promise.reject(axiosError(401)))
    const outcome = await refreshTokens("rt").then(
      () => "resolved",
      () => "rejected",
    )
    expect(outcome).toBe("rejected")
    expect(postMock).toHaveBeenCalledTimes(1)
  })

  it("KHÔNG retry khi 403 (refresh token bị thu hồi)", async () => {
    postMock.mockImplementationOnce(() => Promise.reject(axiosError(403)))
    const outcome = await refreshTokens("rt").then(
      () => "resolved",
      () => "rejected",
    )
    expect(outcome).toBe("rejected")
    expect(postMock).toHaveBeenCalledTimes(1)
  })
})
