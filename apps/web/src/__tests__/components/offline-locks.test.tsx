import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "@/components/inbox/inbox-ui"
import { PosCartPanel } from "@/app/(dashboard)/pos/_components/pos-cart-panel"
import { PosOrderScreen } from "@/app/(dashboard)/pos/_components/pos-order-screen"
import { EMPTY_CART } from "@/lib/pos-cart"

const setOnline = (v: boolean) => {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v })
  act(() => { window.dispatchEvent(new Event(v ? "online" : "offline")) })
}

describe("mất mạng ⇒ khoá thao tác gửi lên máy chủ, giữ nguyên dữ liệu đang nhập", () => {
  afterEach(() => setOnline(true))

  it("ô soạn tin hộp thư: vẫn gõ được, nút Gửi khoá, có câu giải thích", () => {
    const send = vi.fn()
    render(<Composer value="Chào chị" onChange={() => {}} onSend={send} pending={false} placeholder="Nhập tin" ariaLabel="Tin nhắn" />)
    expect(screen.getByRole("button", { name: "Gửi" })).toBeEnabled()
    setOnline(false)
    expect(screen.getByRole("button", { name: "Gửi" })).toBeDisabled()
    expect(screen.getByLabelText("Tin nhắn")).toBeEnabled()
    expect(screen.getByRole("status").textContent).toContain("Đang mất mạng")
  })

  it("giỏ POS: Lưu đơn / Thanh toán khoá khi mất mạng, mở lại khi có mạng", () => {
    const cart = { ...EMPTY_CART, lines: [{ key: "a", product_id: 1, name: "Cà phê sữa", unit_price: 29000, quantity: 2, options: [], note: "" }] }
    const noop = () => {}
    render(
      <PosCartPanel cart={cart} setCart={noop} tableName={null} busy={false} onEditLine={noop} onOpenTable={noop}
        onPay={noop} onSave={noop} onProvisional={noop} onVoid={noop} onNew={noop} />,
    )
    expect(screen.getByRole("button", { name: "Thanh toán" })).toBeEnabled()
    setOnline(false)
    expect(screen.getByRole("button", { name: "Thanh toán" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Lưu đơn" })).toBeDisabled()
    setOnline(true)
    expect(screen.getByRole("button", { name: "Thanh toán" })).toBeEnabled()
  })
  it("màn đơn POS điện thoại: Thu sau / Thanh toán / Huỷ đơn khoá khi mất mạng, mở lại khi có mạng", async () => {
    const cart = { ...EMPTY_CART, orderId: 9, orderCode: "20260930-0001", lines: [{ key: "a", product_id: 1, name: "Cà phê sữa", unit_price: 29000, quantity: 2, options: [], note: "" }] }
    const noop = () => {}
    render(
      <PosOrderScreen cart={cart} setCart={noop} tableName={null} busy={false} open yielding={false} onBack={noop} onEditLine={noop} onOpenTable={noop}
        customDiscount={false} setCustomDiscount={noop}
        onPay={noop} onSave={noop} onProvisional={noop} onVoid={noop} onNew={noop} />,
    )
    expect(screen.getByRole("button", { name: "Thanh toán" })).toBeEnabled()
    setOnline(false)
    expect(screen.getByRole("button", { name: "Thanh toán" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Thu sau (lưu đơn)" })).toBeDisabled()
    expect(screen.getByLabelText("Ghi chú đơn")).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Thao tác khác" }))
    expect(await screen.findByRole("menuitem", { name: "Huỷ đơn này" })).toHaveAttribute("aria-disabled", "true")
    setOnline(true)
    expect(screen.getByRole("button", { name: "Thanh toán" })).toBeEnabled()
  })
})
