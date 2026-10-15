/**
 * POS — hằng số dùng chung.
 *
 * RBAC quyền + phạm vi: KHÔNG còn danh sách role. Quyền `pos.sell` (scoped: xem ca/đơn
 * đã thu của ai), `pos.manage` (cấu hình + huỷ đơn đã thu), `pos.report` (báo cáo ngày).
 * Danh tính LUÔN từ JWT (`@CurrentUser()`), KHÔNG tin header.
 */

export const ORDER_TYPES = ['dine_in', 'takeaway'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const DISCOUNT_TYPES = ['none', 'percent', 'amount'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const PAYMENT_METHODS = ['cash', 'bank_transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Trần an toàn cho mọi số tiền (VND) — 1.000 tỉ, xa dưới 2^53 nên tính bằng `number` không mất chính xác. */
export const MAX_MONEY = 1_000_000_000_000;
export const MAX_QTY = 999;
