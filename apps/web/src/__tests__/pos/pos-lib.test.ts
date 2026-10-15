import { describe, it, expect } from "vitest"
import {
  addLine, cartFromOrder, cartTotals, cashSuggestions, changeQty, discountAmount, editLine, EMPTY_CART, MAX_LINE_QTY, toWritePayload,
  type CartState,
} from "@/lib/pos-cart"
import { receiptFromCart, receiptFromOrder } from "@/lib/pos-receipt"
import { parseMoney, posErrorMessage } from "@/lib/pos-format"
import { EXTRA_MENU_ITEMS } from "@/components/app-shell/menu-extra"
import type { PosModifier, PosOrder } from "@/types/pos"

const cafe = { id: 1, name: "Cà phê sữa", price: 30000 }
const tra = { id: 2, name: "Trà đào", price: 45000 }
const sizeL: PosModifier = { id: 10, group_name: "Size", name: "L", price_delta: 5000, sort_order: 0, is_active: true }
const itLd: PosModifier = { id: 11, group_name: "Đá", name: "Ít đá", price_delta: 0, sort_order: 0, is_active: true }

describe("giỏ hàng POS", () => {
  it("cộng dồn cùng món + tuỳ chọn + ghi chú; khác tuỳ chọn thì tách dòng", () => {
    let l = addLine([], cafe, [sizeL], 1)
    l = addLine(l, cafe, [sizeL], 2)
    expect(l).toHaveLength(1)
    expect(l[0].quantity).toBe(3)
    l = addLine(l, cafe, [], 1)
    l = addLine(l, cafe, [sizeL], 1, "ít ngọt")
    expect(l).toHaveLength(3)
  })
  it("thứ tự chọn tuỳ chọn không tạo dòng trùng", () => {
    const l = addLine(addLine([], cafe, [sizeL, itLd]), cafe, [itLd, sizeL])
    expect(l).toHaveLength(1)
    expect(l[0].quantity).toBe(2)
  })
  it("tổng xem trước = (giá + tuỳ chọn) × SL, giảm % làm tròn xuống, giảm tiền không vượt tạm tính", () => {
    const lines = addLine(addLine([], cafe, [sizeL], 2), tra)
    expect(cartTotals({ lines, discountType: "percent", discountValue: 10 })).toEqual({ subtotal: 115000, discount: 11500, total: 103500 })
    expect(discountAmount(50000, "amount", 999999)).toBe(50000)
    expect(discountAmount(99999, "percent", 10)).toBe(9999)
    expect(discountAmount(100, "percent", 500)).toBe(100)
  })
  it("giảm SL về 0 thì bỏ dòng; SL bị chặn ở trần", () => {
    const l = addLine([], cafe)
    expect(changeQty(l, l[0].key, -1)).toEqual([])
    expect(changeQty(l, l[0].key, 5000)[0].quantity).toBe(MAX_LINE_QTY)
  })
  it("sửa dòng thành trùng dòng khác thì gộp số lượng", () => {
    const l = addLine(addLine([], cafe, [], 1), cafe, [sizeL], 2)
    const out = editLine(l, l[1].key, { note: "", options: [], quantity: 2 })
    expect(out).toHaveLength(1)
    expect(out[0].quantity).toBe(3)
  })
  it("payload gửi BE KHÔNG chứa giá/tổng", () => {
    const cart: CartState = { ...EMPTY_CART, tableId: 3, lines: addLine([], cafe, [sizeL], 2, "ít ngọt"), discountType: "percent", discountValue: 5 }
    const p = toWritePayload(cart)
    expect(p).toEqual({
      table_id: 3, order_type: "dine_in", note: "", discount_type: "percent", discount_value: 5,
      items: [{ product_id: 1, quantity: 2, modifier_ids: [10], note: "ít ngọt" }],
    })
    expect(JSON.stringify(p)).not.toMatch(/price|total|unit/)
  })
  it("gợi ý tiền khách đưa: làm tròn lên mệnh giá VND, không gồm đúng số tiền, tối đa 4", () => {
    expect(cashSuggestions(103500)).toEqual([110000, 120000, 150000, 200000])
    expect(cashSuggestions(60000)).toEqual([100000, 200000, 500000])
    expect(cashSuggestions(500000)).toEqual([600000])
    expect(cashSuggestions(0)).toEqual([])
  })
})

const order: PosOrder = {
  id: 7, code: "20260930-0001", shift_id: 1, table_id: 3, order_type: "dine_in", status: "paid", note: null,
  subtotal: 115000, discount_type: "percent", discount_value: 10, discount_amount: 11500, total: 103500,
  created_by: 1, created_at: "2026-09-30T03:00:00Z", paid_by: 1, paid_at: "2026-09-30T03:10:00Z", void_reason: null,
  items: [{ id: 1, product_id: 1, product_name: "Cà phê sữa", unit_price: 30000, quantity: 2, options: [{ id: 10, group_name: "Size", name: "L", price_delta: 5000 }], note: "ít ngọt", line_total: 70000 }],
  payments: [{ id: 1, method: "cash", amount: 103500, tendered: 200000, change: 96500, reference: null, shift_id: 1, created_at: "2026-09-30T03:10:00Z" }],
}

describe("hoá đơn / đơn đã lưu", () => {
  it("nạp lại giỏ từ đơn BE giữ nguyên tuỳ chọn, ghi chú, giảm giá", () => {
    const c = cartFromOrder(order)
    expect(c.orderId).toBe(7)
    expect(c.lines[0]).toMatchObject({ quantity: 2, note: "ít ngọt", unit_price: 30000 })
    expect(c.discountType).toBe("percent")
  })
  it("hoá đơn dùng SỐ LIỆU BE (không tính lại); tạm tính từ giỏ tính xem trước", () => {
    const r = receiptFromOrder(order, "B1")
    expect(r).toMatchObject({ kind: "bill", place: "Bàn B1", total: 103500, discount: 11500 })
    expect(r.lines[0]).toMatchObject({ unit: 35000, total: 70000 })
    expect(r.payments[0]).toMatchObject({ tendered: 200000, change: 96500 })
    const t = receiptFromCart({ ...EMPTY_CART, orderType: "takeaway", lines: addLine([], tra, [], 2) }, null)
    expect(t).toMatchObject({ kind: "provisional", code: "TẠM TÍNH", place: "Mang đi", total: 90000 })
  })
})

describe("định dạng & RBAC", () => {
  it("parseMoney bỏ ký tự không phải số; rỗng → null", () => {
    expect(parseMoney("1.250.000đ")).toBe(1250000)
    expect(parseMoney("")).toBeNull()
    expect(parseMoney("abc")).toBeNull()
  })
  it("posErrorMessage nối mảng lỗi validation của NestJS", () => {
    expect(posErrorMessage(new Error("x"), "dự phòng")).toBe("dự phòng")
  })
  it("menu POS: gate bằng quyền pos.sell (không còn deniedRoles theo role)", () => {
    const item = EXTRA_MENU_ITEMS.find((i) => i.key === "pos")
    expect(item?.href).toBe("/pos")
    expect(item?.permission).toBe("pos.sell")
  })
})
