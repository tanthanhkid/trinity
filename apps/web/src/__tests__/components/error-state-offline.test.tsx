import { act, fireEvent, render, screen } from "@testing-library/react"
import { AxiosError, AxiosHeaders } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"

const toastSuccess = vi.fn()
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }))

import { ErrorState } from "@/components/ui/error-state"
import { OfflineBanner } from "@/components/offline-banner"
import { getApiErrorMessage, NETWORK_ERROR_MESSAGE, TIMEOUT_MESSAGE } from "@/lib/api-client"

describe("getApiErrorMessage — không tới được máy chủ", () => {
  it("mất mạng ⇒ nói rõ + cách sửa; quá giờ ⇒ câu riêng; huỷ yêu cầu ⇒ fallback", () => {
    expect(getApiErrorMessage(new AxiosError("Network Error", "ERR_NETWORK"), "Không lưu được")).toBe("Không lưu được: không kết nối được máy chủ. Kiểm tra Internet rồi thử lại.")
    expect(getApiErrorMessage(new AxiosError("timeout", "ECONNABORTED"), "Không lưu được")).toContain(TIMEOUT_MESSAGE.slice(1))
    expect(getApiErrorMessage(new AxiosError("canceled", "ERR_CANCELED"), "x")).toBe("x")
  })
})

describe("ErrorState", () => {
  it("tiêu đề + câu giải thích từ lỗi + nút Thử lại gọi onRetry", () => {
    const retry = vi.fn()
    render(<ErrorState title="Không tải được danh sách khách hàng" error={new AxiosError("Network Error", "ERR_NETWORK")} onRetry={retry} />)
    const box = screen.getByRole("alert")
    expect(box.textContent).toContain("Không tải được danh sách khách hàng")
    expect(box.textContent).toContain(NETWORK_ERROR_MESSAGE)
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it("hết phiên ⇒ nút Đăng nhập lại; thiếu quyền ⇒ không có nút Thử lại", () => {
    const res = (status: number) => new AxiosError("x", "ERR_BAD_REQUEST", undefined, undefined, { data: {}, status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() } })
    const { unmount } = render(<ErrorState error={res(401)} onRetry={() => {}} />)
    expect(screen.getByRole("link", { name: "Đăng nhập lại" })).toHaveAttribute("href", "/login")
    expect(screen.queryByRole("button", { name: "Thử lại" })).toBeNull()
    unmount()
    render(<ErrorState error={res(403)} onRetry={() => {}} />)
    expect(screen.getByRole("alert").textContent).toContain("chưa có quyền")
    expect(screen.queryByRole("button", { name: "Thử lại" })).toBeNull()
  })

  it("không có onRetry ⇒ không có nút; đang thử lại ⇒ nút khoá", () => {
    const { rerender } = render(<ErrorState message="Lỗi riêng" />)
    expect(screen.queryByRole("button")).toBeNull()
    rerender(<ErrorState compact message="Lỗi riêng" onRetry={() => {}} retrying />)
    expect(screen.getByRole("button", { name: /Đang thử lại/ })).toBeDisabled()
  })
})

describe("OfflineBanner", () => {
  const setOnline = (v: boolean) => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v })
    act(() => { window.dispatchEvent(new Event(v ? "online" : "offline")) })
  }
  afterEach(() => setOnline(true))

  it("mất mạng ⇒ hiện dải báo; có mạng lại ⇒ ẩn + báo một câu", () => {
    render(<OfflineBanner />)
    expect(screen.queryByTestId("offline-banner")).toBeNull()
    setOnline(false)
    expect(screen.getByTestId("offline-banner").textContent).toContain("Mất kết nối mạng")
    setOnline(true)
    expect(screen.queryByTestId("offline-banner")).toBeNull()
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("Đã có mạng lại"))
  })
})
