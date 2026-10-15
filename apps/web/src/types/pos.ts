/** Kiểu dữ liệu POS — mirror response của `services/commerce/src/pos/*`. Tiền = số nguyên VND. */
export type PosOrderType = "dine_in" | "takeaway"
export type PosDiscountType = "none" | "percent" | "amount"
export type PosPaymentMethod = "cash" | "bank_transfer"
export type PosOrderStatus = "open" | "paid" | "void"

export interface PosSettings {
  id: number
  store_name: string
  address: string | null
  phone: string | null
  receipt_footer: string | null
  bank_bin: string | null
  bank_account_no: string | null
  bank_account_name: string | null
  menu_category_ids: number[]
}

export interface PosMenuCategory { id: number; code: string; name: string }
export interface PosMenuProduct {
  id: number
  code: string
  name: string
  price: number
  image_url: string | null
  category_id: number | null
}
export interface PosMenu { categories: PosMenuCategory[]; products: PosMenuProduct[] }

export interface PosModifier {
  id: number
  group_name: string
  name: string
  price_delta: number
  sort_order: number
  is_active: boolean
}
export interface PosArea { id: number; name: string; sort_order: number; is_active: boolean }
export interface PosTable {
  id: number
  area_id: number
  name: string
  sort_order: number
  is_active: boolean
  open_order: { id: number; code: string; total: number } | null
}

export interface PosOrderOption { id: number; group_name: string; name: string; price_delta: number }
export interface PosOrderItem {
  id: number
  product_id: number
  product_name: string
  unit_price: number
  quantity: number
  options: PosOrderOption[]
  note: string | null
  line_total: number
}
export interface PosPayment {
  id: number
  method: PosPaymentMethod
  amount: number
  tendered: number | null
  change: number
  reference: string | null
  shift_id: number
  created_at: string
}
export interface PosOrder {
  id: number
  code: string
  shift_id: number
  table_id: number | null
  order_type: PosOrderType
  status: PosOrderStatus
  note: string | null
  subtotal: number
  discount_type: PosDiscountType
  discount_value: number
  discount_amount: number
  total: number
  created_by: number
  created_at: string
  paid_by: number | null
  paid_at: string | null
  void_reason: string | null
  items: PosOrderItem[]
  payments: PosPayment[]
}

export interface PosShift {
  id: number
  opened_by: number
  opened_at: string
  status: "open" | "closed"
  opening_cash: number
  closed_at: string | null
  closing_cash_counted: number | null
  expected_cash: number | null
  cash_diff: number | null
  note: string | null
}
export interface PosShiftSummary {
  paid_orders: number
  void_orders: number
  cash_sales: number
  transfer_sales: number
  expected_cash: number
}
export interface PosShiftState { shift: PosShift | null; summary: PosShiftSummary | null }

export interface PosDailyReport {
  date: string
  order_count: number
  revenue: number
  subtotal: number
  discount: number
  avg_order_value: number
  by_method: Array<{ method: PosPaymentMethod; amount: number }>
  by_product: Array<{ product_id: number; product_name: string; quantity: number; revenue: number }>
  by_hour: Array<{ hour: number; orders: number; revenue: number }>
  by_product_truncated: boolean
}

export interface PosQr { payload: string; amount: number; content: string; account_name: string | null; account_no: string; bank_bin: string }

/** Payload gửi BE — KHÔNG có giá/tổng (BE tự tính). */
export interface PosOrderItemInput { product_id: number; quantity: number; modifier_ids?: number[]; note?: string }
export interface PosOrderWrite {
  table_id?: number | null
  order_type?: PosOrderType
  note?: string
  discount_type?: PosDiscountType
  discount_value?: number
  items?: PosOrderItemInput[]
}
export interface PosPaymentInput { method: PosPaymentMethod; amount: number; tendered?: number; reference?: string }
