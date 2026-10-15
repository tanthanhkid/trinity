import { cartTotals, lineTotal, lineUnitPrice, type CartState } from "@/lib/pos-cart"
import type { PosOrder, PosPayment } from "@/types/pos"

/** Mô hình hoá đơn in khổ 80mm. Hàm thuần để test được, component chỉ render. */
export interface ReceiptLine { name: string; options: string; note: string; quantity: number; unit: number; total: number }
export interface ReceiptData {
  kind: "provisional" | "bill"
  code: string
  place: string
  at: string | null
  lines: ReceiptLine[]
  subtotal: number
  discount: number
  total: number
  payments: Array<Pick<PosPayment, "method" | "amount" | "tendered" | "change">>
}

const placeOf = (orderType: string, tableName: string | null) =>
  orderType === "takeaway" ? "Mang đi" : tableName ? `Bàn ${tableName}` : "Tại quán"

/** Tạm tính từ giỏ hiện tại (chưa lưu cũng in được). */
export function receiptFromCart(c: CartState, tableName: string | null): ReceiptData {
  const t = cartTotals(c)
  return {
    kind: "provisional", code: c.orderCode ?? "TẠM TÍNH", place: placeOf(c.orderType, tableName), at: null,
    lines: c.lines.map((l) => ({
      name: l.name, options: l.options.map((o) => o.name).join(", "), note: l.note,
      quantity: l.quantity, unit: lineUnitPrice(l), total: lineTotal(l),
    })),
    subtotal: t.subtotal, discount: t.discount, total: t.total, payments: [],
  }
}

/** Hoá đơn từ đơn đã lưu (dùng số liệu BE đã tính, không tính lại ở FE). */
export function receiptFromOrder(o: PosOrder, tableName: string | null): ReceiptData {
  return {
    kind: o.status === "paid" ? "bill" : "provisional", code: o.code, place: placeOf(o.order_type, tableName),
    at: o.paid_at ?? o.created_at,
    lines: o.items.map((i) => ({
      name: i.product_name, options: i.options.map((x) => x.name).join(", "), note: i.note ?? "",
      quantity: i.quantity, unit: i.unit_price + i.options.reduce((s, x) => s + x.price_delta, 0), total: i.line_total,
    })),
    subtotal: o.subtotal, discount: o.discount_amount, total: o.total,
    payments: o.payments.map((p) => ({ method: p.method, amount: p.amount, tendered: p.tendered, change: p.change })),
  }
}
