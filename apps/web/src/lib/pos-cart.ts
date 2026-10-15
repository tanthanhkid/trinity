import type {
  PosDiscountType, PosMenuProduct, PosModifier, PosOrder, PosOrderOption, PosOrderType, PosOrderWrite,
} from "@/types/pos"

/**
 * Giỏ hàng POS — HÀM THUẦN. Số liệu ở đây CHỈ để hiển thị xem trước; BE luôn tính lại
 * giá/tổng từ DB (payload gửi đi KHÔNG chứa giá/tổng — xem `toWritePayload`).
 * Công thức giảm giá mirror `calcDiscount` ở `services/commerce/src/pos/pos-money.util.ts`.
 */
export const MAX_LINE_QTY = 999

export interface CartLine {
  key: string
  product_id: number
  name: string
  unit_price: number
  quantity: number
  options: PosOrderOption[]
  note: string
}

export interface CartState {
  orderId: number | null
  orderCode: string | null
  lines: CartLine[]
  orderType: PosOrderType
  tableId: number | null
  note: string
  discountType: PosDiscountType
  discountValue: number
}

export const EMPTY_CART: CartState = {
  orderId: null, orderCode: null, lines: [], orderType: "dine_in", tableId: null,
  note: "", discountType: "none", discountValue: 0,
}

const lineKey = (productId: number, optionIds: number[], note: string) =>
  `${productId}|${[...optionIds].sort((a, b) => a - b).join(",")}|${note.trim()}`

export function lineUnitPrice(l: Pick<CartLine, "unit_price" | "options">): number {
  return l.unit_price + l.options.reduce((s, o) => s + o.price_delta, 0)
}
export const lineTotal = (l: CartLine): number => lineUnitPrice(l) * l.quantity
export const cartSubtotal = (lines: CartLine[]): number => lines.reduce((s, l) => s + lineTotal(l), 0)

export function discountAmount(subtotal: number, type: PosDiscountType, value: number): number {
  if (type === "percent") return Math.floor((subtotal * Math.min(Math.max(value, 0), 100)) / 100)
  if (type === "amount") return Math.min(Math.max(value, 0), subtotal)
  return 0
}

export function cartTotals(c: Pick<CartState, "lines" | "discountType" | "discountValue">) {
  const subtotal = cartSubtotal(c.lines)
  const discount = discountAmount(subtotal, c.discountType, c.discountValue)
  return { subtotal, discount, total: subtotal - discount }
}

export const cartCount = (lines: CartLine[]): number => lines.reduce((s, l) => s + l.quantity, 0)

/** Thêm món; trùng món + tuỳ chọn + ghi chú thì cộng dồn số lượng thay vì thêm dòng. */
export function addLine(
  lines: CartLine[], product: Pick<PosMenuProduct, "id" | "name" | "price">,
  options: PosModifier[] = [], quantity = 1, note = "",
): CartLine[] {
  const opts: PosOrderOption[] = options.map((o) => ({ id: o.id, group_name: o.group_name, name: o.name, price_delta: o.price_delta }))
  const key = lineKey(product.id, opts.map((o) => o.id), note)
  const at = lines.findIndex((l) => l.key === key)
  if (at >= 0) {
    return lines.map((l, i) => (i === at ? { ...l, quantity: Math.min(l.quantity + quantity, MAX_LINE_QTY) } : l))
  }
  return [...lines, { key, product_id: product.id, name: product.name, unit_price: product.price, quantity, options: opts, note: note.trim() }]
}

/** Đổi số lượng theo delta; về 0 thì bỏ dòng. */
export function changeQty(lines: CartLine[], key: string, delta: number): CartLine[] {
  return lines
    .map((l) => (l.key === key ? { ...l, quantity: Math.min(l.quantity + delta, MAX_LINE_QTY) } : l))
    .filter((l) => l.quantity > 0)
}

export function removeLine(lines: CartLine[], key: string): CartLine[] {
  return lines.filter((l) => l.key !== key)
}

/** Sửa 1 dòng (tuỳ chọn/ghi chú/số lượng). Đổi xong mà trùng dòng khác (cùng món + tuỳ chọn + ghi chú) thì gộp số lượng. */
export function editLine(
  lines: CartLine[], key: string, patch: { note: string; options: PosOrderOption[]; quantity: number },
): CartLine[] {
  const merged: CartLine[] = []
  for (const l of lines) {
    const next = l.key === key
      ? { ...l, note: patch.note.trim(), options: patch.options, quantity: Math.min(Math.max(patch.quantity, 1), MAX_LINE_QTY),
          key: lineKey(l.product_id, patch.options.map((o) => o.id), patch.note) }
      : l
    const dup = merged.findIndex((m) => m.key === next.key)
    if (dup >= 0) merged[dup] = { ...merged[dup], quantity: Math.min(merged[dup].quantity + next.quantity, MAX_LINE_QTY) }
    else merged.push(next)
  }
  return merged
}

/** Payload ghi đơn: chỉ id + số lượng + tuỳ chọn + ghi chú. KHÔNG có giá/tổng. */
export function toWritePayload(c: CartState): PosOrderWrite {
  return {
    table_id: c.tableId,
    order_type: c.orderType,
    note: c.note,
    discount_type: c.discountType,
    discount_value: c.discountType === "none" ? 0 : c.discountValue,
    items: c.lines.map((l) => ({
      product_id: l.product_id,
      quantity: l.quantity,
      ...(l.options.length ? { modifier_ids: l.options.map((o) => o.id) } : {}),
      ...(l.note ? { note: l.note } : {}),
    })),
  }
}

export function cartFromOrder(o: PosOrder): CartState {
  return {
    orderId: o.id, orderCode: o.code, orderType: o.order_type, tableId: o.table_id, note: o.note ?? "",
    discountType: o.discount_type, discountValue: o.discount_value,
    lines: o.items.map((i) => ({
      key: lineKey(i.product_id, i.options.map((x) => x.id), i.note ?? ""),
      product_id: i.product_id, name: i.product_name, unit_price: i.unit_price, quantity: i.quantity,
      options: i.options, note: i.note ?? "",
    })),
  }
}

const NOTES = [10_000, 20_000, 50_000, 100_000, 200_000, 500_000]

/** Gợi ý tiền khách đưa: làm tròn LÊN theo các mệnh giá VND phổ biến (loại trùng, tối đa 4, không gồm đúng số tiền). */
export function cashSuggestions(amount: number): number[] {
  if (amount <= 0) return []
  const out = new Set<number>()
  for (const n of NOTES) {
    const up = Math.ceil(amount / n) * n
    if (up > amount) out.add(up)
  }
  return [...out].sort((a, b) => a - b).slice(0, 4)
}
