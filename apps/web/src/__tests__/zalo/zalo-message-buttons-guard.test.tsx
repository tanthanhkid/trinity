/**
 * Test guard nút "Nhắn tin Zalo".
 *
 * Quyền nhắn chỉ dựa `isMaskedPhone(phone)` (BE `PhoneMaskInterceptor` là
 * nguồn chân lý). Test này chạy với user KHÔNG có quyền xem SĐT đầy đủ:
 *  - Số THẬT (không có "*") → mở deeplink zalo.me (window.open), KHÔNG toast lỗi.
 *  - Số bị CHE ("0900***001") → toast lỗi, KHÔNG mở gì (không leak).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }))

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}))


import { ZaloPhoneLink } from "@/components/zalo-phone-link"
import { ZaloActions, ZaloIconLink } from "@/components/zalo-actions"

describe("Nút Nhắn tin Zalo — guard theo isMaskedPhone (KHÔNG theo role)", () => {
  let openSpy: MockInstance<typeof window.open>

  beforeEach(() => {
    mockToastError.mockClear()
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
  })

  // vitest ≥ 4: spyOn trên hàm đã là spy trả lại spy cũ (không xoá lượt gọi) ⇒ trả về như cũ sau mỗi test.
  afterEach(() => openSpy.mockRestore())

  it("người phụ trách + số THẬT → ZaloPhoneLink mở deeplink zalo.me, KHÔNG toast lỗi", () => {
    render(<ZaloPhoneLink phone="0901234567" masked />)
    fireEvent.click(screen.getByRole("button"))
    expect(openSpy).toHaveBeenCalledWith(
      "https://zalo.me/0901234567",
      "_blank",
      "noopener",
    )
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it("người phụ trách + số bị CHE → ZaloPhoneLink toast lỗi, KHÔNG mở deeplink (không leak)", () => {
    render(<ZaloPhoneLink phone="0900***001" masked />)
    fireEvent.click(screen.getByRole("button"))
    expect(openSpy).not.toHaveBeenCalled()
    expect(mockToastError).toHaveBeenCalledTimes(1)
  })

  it("người phụ trách + số THẬT → ZaloActions mở deeplink zalo.me", () => {
    render(<ZaloActions phone="+84901234567" />)
    fireEvent.click(screen.getByRole("button"))
    expect(openSpy).toHaveBeenCalledWith(
      "https://zalo.me/0901234567",
      "_blank",
      "noopener",
    )
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it("người phụ trách + số bị CHE → ZaloActions toast lỗi, KHÔNG mở", () => {
    render(<ZaloActions phone="0900-000-**01" />)
    fireEvent.click(screen.getByRole("button"))
    expect(openSpy).not.toHaveBeenCalled()
    expect(mockToastError).toHaveBeenCalledTimes(1)
  })

  it("người phụ trách + số THẬT → ZaloIconLink mở deeplink zalo.me", () => {
    render(<ZaloIconLink phone="0901234567" />)
    fireEvent.click(screen.getByRole("button"))
    expect(openSpy).toHaveBeenCalledWith(
      "https://zalo.me/0901234567",
      "_blank",
      "noopener",
    )
    expect(mockToastError).not.toHaveBeenCalled()
  })
})
