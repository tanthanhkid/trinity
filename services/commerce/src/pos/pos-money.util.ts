import { BadRequestException } from '@nestjs/common';
import { DiscountType, MAX_MONEY, PaymentMethod } from './pos.constants';

/**
 * Tính tiền POS — HÀM THUẦN, số nguyên VND. BE là nguồn duy nhất của mọi tổng tiền:
 * client KHÔNG gửi giá/tổng, chỉ gửi id + số lượng.
 */
export interface ModifierSnapshot {
  id: number;
  group_name: string;
  name: string;
  price_delta: number;
}

function assertMoney(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_MONEY) {
    throw new BadRequestException(`${label} không hợp lệ hoặc vượt giới hạn`);
  }
}

export function calcLineTotal(unitPrice: number, mods: ModifierSnapshot[], quantity: number): number {
  const unit = unitPrice + mods.reduce((s, m) => s + m.price_delta, 0);
  if (unit < 0) throw new BadRequestException('Đơn giá sau tuỳ chọn không được âm');
  const total = unit * quantity;
  assertMoney(total, 'Thành tiền');
  return total;
}

export function calcDiscount(subtotal: number, type: DiscountType, value: number): number {
  if (type === 'none') return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException('Giá trị giảm giá không hợp lệ');
  }
  if (type === 'percent') {
    if (value > 100) throw new BadRequestException('Giảm giá phần trăm tối đa 100');
    return Math.floor((subtotal * value) / 100);
  }
  if (value > subtotal) throw new BadRequestException('Giảm giá không được lớn hơn tạm tính');
  return value;
}

export interface OrderTotals {
  subtotal: number;
  discount_amount: number;
  total: number;
}

export function calcTotals(lineTotals: number[], type: DiscountType, value: number): OrderTotals {
  const subtotal = lineTotals.reduce((s, n) => s + n, 0);
  assertMoney(subtotal, 'Tạm tính');
  const discount_amount = calcDiscount(subtotal, type, value);
  return { subtotal, discount_amount, total: subtotal - discount_amount };
}

export interface PaymentInput {
  method: PaymentMethod;
  amount: number;
  tendered?: number | null;
  reference?: string | null;
}

export interface PaymentRow {
  method: PaymentMethod;
  amount: number;
  tendered: number | null;
  change: number;
  reference: string | null;
}

/** Chuẩn hoá dòng thanh toán: tổng `amount` PHẢI đúng bằng `total`; tiền mặt tính tiền thối. */
export function buildPaymentRows(inputs: PaymentInput[], total: number): PaymentRow[] {
  if (total === 0 && inputs.length === 0) return [];
  if (inputs.length === 0) throw new BadRequestException('Cần ít nhất một dòng thanh toán');
  const rows = inputs.map(toPaymentRow);
  const paid = rows.reduce((s, r) => s + r.amount, 0);
  if (paid !== total) {
    throw new BadRequestException(`Tổng thanh toán ${paid} phải đúng bằng tổng đơn ${total}`);
  }
  return rows;
}

function toPaymentRow(p: PaymentInput): PaymentRow {
  assertMoney(p.amount, 'Số tiền thanh toán');
  if (p.amount === 0) throw new BadRequestException('Số tiền thanh toán phải lớn hơn 0');
  const reference = p.reference?.trim() || null;
  if (p.method !== 'cash') {
    return { method: p.method, amount: p.amount, tendered: null, change: 0, reference };
  }
  const tendered = p.tendered ?? p.amount;
  assertMoney(tendered, 'Tiền khách đưa');
  if (tendered < p.amount) throw new BadRequestException('Tiền khách đưa chưa đủ');
  return { method: 'cash', amount: p.amount, tendered, change: tendered - p.amount, reference };
}
