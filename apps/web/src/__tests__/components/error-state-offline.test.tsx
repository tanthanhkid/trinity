import { act, fireEvent, render, screen } from "@testing-library/react"
import { AxiosError } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"

const toastSuccess = vi.fn()
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }))

import { ErrorState } from "@/components/ui/error-state"
import { OfflineBanner } from "@/components/offline-banner"
import { getApiErrorMessage, NETWORK_ERROR_MESSAGE, TIMEOUT_MESSAGE } from "@/lib/api-client"

describe("getApiErrorMessage — không tới được máy chủ", () => {
  it("mất mạng ⇒ nói rõ + cách sửa; quá giờ ⇒ câu riêng; huỷ yêu cầu ⇒ fallback", () => {
    expect(getApiErrorMessage(new AxiosError("Network Error", "ERR_NETWORK"), "x")).toBe(NETWORK_ERROR_MESSAGE)
    expect(getApiErrorMessage(new AxiosError("timeout", "ECONNABORTED"), "x")).toBe(TIMEOUT_MESSAGE)
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
