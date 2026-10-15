import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PosOrder } from "@/types/pos"

const mutate = vi.fn()
vi.mock("@/hooks/pos/use-pos", () => ({
  usePayOrder: () => ({ mutate, isPending: false }),
  fetchPosQr: vi.fn().mockResolvedValue({ payload: "000201", amount: 40000, content: "HD202609300001", account_name: "QUAN A", account_no: "0123456789", bank_bin: "970436" }),
}))
vi.mock("react-qr-code", () => ({ default: ({ value }: { value: string }) => <div data-testid="qr">{value}</div> }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { PosPaymentDialog } from "@/app/(dashboard)/pos/_components/pos-payment-dialog"

const order = { id: 5, code: "20260930-0001", total: 103500, status: "open" } as PosOrder
const renderDialog = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PosPaymentDialog order={order} onClose={() => undefined} onPaid={() => undefined} onPrint={() => undefined} />
    </QueryClientProvider>,
  )

describe("PosPaymentDialog", () => {
  beforeEach(() => mutate.mockClear())

  it("mặc định 1 dòng tiền mặt đủ tổng; xác nhận gửi payload KHÔNG có tổng đơn", () => {
    renderDialog()
    const confirm = screen.getByRole("button", { name: "Xác nhận thanh toán" })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(mutate).toHaveBeenCalledTimes(1)
    const arg = mutate.mock.calls[0][0]
    expect(arg).toEqual({ id: 5, payments: [{ method: "cash", amount: 103500, tendered: 103500 }] })
  })

  it("chọn mệnh giá khách đưa → hiện tiền thối và gửi tendered", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /200\.000đ/ }))
    expect(screen.getByText(/Tiền thối: 96\.500đ/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Xác nhận thanh toán" }))
    expect(mutate.mock.calls[0][0].payments[0]).toMatchObject({ amount: 103500, tendered: 200000 })
  })

  it("chia thanh toán: giảm tiền mặt → còn thiếu; thêm dòng chuyển khoản, phải tick đã nhận tiền mới xác nhận được", async () => {
    renderDialog()
    const amount = screen.getAllByRole("textbox")[0]
    fireEvent.change(amount, { target: { value: "63500" } })
    expect(screen.getByText(/Còn thiếu 40\.000đ/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Xác nhận thanh toán" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "+ Chuyển khoản" }))
    await waitFor(() => expect(screen.getByTestId("qr")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Xác nhận thanh toán" })).toBeDisabled()
    fireEvent.click(screen.getByLabelText("Đã nhận đủ tiền chuyển khoản"))
    const confirm = screen.getByRole("button", { name: "Xác nhận thanh toán" })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(mutate.mock.calls[0][0].payments).toEqual([
      { method: "cash", amount: 63500, tendered: 63500 },
      { method: "bank_transfer", amount: 40000 },
    ])
  })

  it("tiền khách đưa thiếu → chặn xác nhận", () => {
    renderDialog()
    const tendered = screen.getAllByRole("textbox")[1]
    fireEvent.change(tendered, { target: { value: "50000" } })
    expect(screen.getByText("Khách đưa chưa đủ")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Xác nhận thanh toán" })).toBeDisabled()
  })
})
