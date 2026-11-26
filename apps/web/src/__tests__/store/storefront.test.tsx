import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Storefront } from "@/app/s/[slug]/storefront"

/** Trang bán hàng công khai: tải cửa hàng, thêm giỏ, đặt đơn (giá do máy chủ tính), chuyển khoản ⇒ QR. */
const STORE = {
  name: "Cửa hàng ABC", tagline: "Bánh nhà làm", theme: "am-ap", accent: "#e11d48", phone: "0900000000", address: null,
  payment: { cod: true, bank_transfer: true },
  products: [{ id: 10, name: "Bánh mì", price: 20000, image_url: null, description: null }, { id: 11, name: "Cà phê", price: 25000, image_url: null, description: null }],
}
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  try { window.localStorage.removeItem("trinity-cart:cua-hang-abc") } catch { /* jsdom không có localStorage */ }
})
afterEach(() => { vi.unstubAllGlobals() })

describe("<Storefront>", () => {
  it("không có cửa hàng ⇒ báo không tìm thấy", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }))
    render(<Storefront slug="khong-co" />)
    expect(await screen.findByText("Không tìm thấy cửa hàng")).toBeTruthy()
  })

  it("thêm giỏ → đặt đơn chuyển khoản → hiện QR + nội dung chuyển khoản", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/store/public/cua-hang-abc") return new Response(JSON.stringify(STORE), { status: 200 })
      if (url === "/api/v1/store/public/cua-hang-abc/orders" && init?.method === "POST") {
        return new Response(JSON.stringify({ code: "DH-ABCDEF", total: 65000, payment_method: "bank_transfer", payment: { qr_data: "00020101021238540010A00000072701240006970422011001234567890208QRIBFTTA53037045405650005802VN62130809DH-ABCDEF6304XXXX", transfer_content: "DH-ABCDEF", bank: { bin: "970422", bank: "MBBank", account_number: "0123456789" } } }), { status: 201 })
      }
      return new Response(JSON.stringify({ status: "new" }), { status: 200 })
    })
    render(<Storefront slug="cua-hang-abc" />)
    expect(await screen.findByRole("heading", { level: 1, name: "Cửa hàng ABC" })).toBeTruthy()
    fireEvent.click(screen.getAllByRole("button", { name: "Thêm vào giỏ" })[0])
    fireEvent.click(screen.getByRole("button", { name: "Thêm Bánh mì" }))
    fireEvent.click(screen.getAllByRole("button", { name: "Thêm vào giỏ" })[0])
    fireEvent.click(screen.getByRole("button", { name: "Giỏ hàng: 3 món" }))
    fireEvent.change(screen.getByLabelText("Họ tên"), { target: { value: "An" } })
    fireEvent.change(screen.getByLabelText("Số điện thoại"), { target: { value: "0912345678" } })
    fireEvent.click(screen.getByLabelText(/Chuyển khoản/))
    fireEvent.click(screen.getByRole("button", { name: /Đặt hàng · 65.000đ/ }))
    await waitFor(() => expect(screen.getByText("Quét mã để thanh toán")).toBeTruthy())
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST")!
    expect(JSON.parse(post[1].body)).toMatchObject({ name: "An", phone: "0912345678", payment_method: "bank_transfer", items: [{ product_id: 10, quantity: 2 }, { product_id: 11, quantity: 1 }] })
    // QR vẽ tại trình duyệt từ chuỗi VietQR (không tải ảnh từ dịch vụ ngoài).
    const qr = screen.getByRole("img", { name: /Mã QR chuyển 65.000đ/ })
    expect(qr.querySelector("svg")).toBeTruthy()
    expect(document.querySelector('img[src*="sepay"]')).toBeNull()
    expect(screen.getByText("DH-ABCDEF", { selector: "span.font-mono" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Sao chép nội dung chuyển khoản" })).toBeTruthy()
    // Nút ở thanh trên của trang kết quả quay lại mua tiếp (không phải nút chết).
    fireEvent.click(screen.getAllByRole("button", { name: "Tiếp tục mua" })[0])
    expect(await screen.findByRole("heading", { level: 2, name: "Sản phẩm" })).toBeTruthy()
  })

  describe("chờ cửa hàng xác nhận chuyển khoản", () => {
    const QR = "00020101021238540010A00000072701240006970422011001234567890208QRIBFTTA53037045405200005802VN62130809DH-ABCDEF6304XXXX"
    async function placeTransfer(status: () => string) {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/v1/store/public/cua-hang-abc") return new Response(JSON.stringify(STORE), { status: 200 })
        if (init?.method === "POST") return new Response(JSON.stringify({ code: "DH-ABCDEF", total: 20000, payment_method: "bank_transfer", payment: { qr_data: QR, transfer_content: "DH-ABCDEF", bank: null } }), { status: 201 })
        return new Response(JSON.stringify({ status: status() }), { status: 200 })
      })
      render(<Storefront slug="cua-hang-abc" />)
      await screen.findByRole("heading", { level: 1, name: "Cửa hàng ABC" })
      fireEvent.click(screen.getAllByRole("button", { name: "Thêm vào giỏ" })[0])
      fireEvent.click(screen.getByRole("button", { name: "Giỏ hàng: 1 món" }))
      fireEvent.change(screen.getByLabelText("Họ tên"), { target: { value: "An" } })
      fireEvent.change(screen.getByLabelText("Số điện thoại"), { target: { value: "0912345678" } })
      fireEvent.click(screen.getByLabelText(/Chuyển khoản/))
      fireEvent.click(screen.getByRole("button", { name: /Đặt hàng/ }))
      await waitFor(() => expect(screen.getByText("Quét mã để thanh toán")).toBeTruthy())
    }
    afterEach(() => { vi.useRealTimers() })

    it("đơn bị huỷ ⇒ câu riêng, không còn hiện QR", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await placeTransfer(() => "cancelled")
      await vi.advanceTimersByTimeAsync(16_000)
      await waitFor(() => expect(screen.getByText("Đơn đã bị huỷ")).toBeTruthy())
      expect(screen.queryByRole("img", { name: /Mã QR/ })).toBeNull()
      expect(screen.getByText(/vui lòng không chuyển khoản/)).toBeTruthy()
    })

    it("cửa hàng xác nhận ⇒ trạng thái kết thúc có câu riêng", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      await placeTransfer(() => "confirmed")
      await vi.advanceTimersByTimeAsync(16_000)
      await waitFor(() => expect(screen.getByText("Cửa hàng đã xác nhận đơn")).toBeTruthy())
      expect(screen.queryByRole("img", { name: /Mã QR/ })).toBeNull()
    })

    it("hết 1 giờ chưa xác nhận ⇒ báo ngừng tự kiểm tra, bấm Kiểm tra lại thì hỏi lại ngay", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      let st = "new"
      await placeTransfer(() => st)
      await vi.advanceTimersByTimeAsync(15_000 * 241)
      await waitFor(() => expect(screen.getByRole("button", { name: "Kiểm tra lại" })).toBeTruthy())
      expect(screen.getByText(/ngừng tự kiểm tra/)).toBeTruthy()
      st = "paid"
      fireEvent.click(screen.getByRole("button", { name: "Kiểm tra lại" }))
      await waitFor(() => expect(screen.getByText("Đã nhận thanh toán")).toBeTruthy())
    })
  })
})
