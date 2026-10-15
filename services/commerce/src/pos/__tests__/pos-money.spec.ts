import { BadRequestException } from '@nestjs/common';
import { buildPaymentRows, calcDiscount, calcLineTotal, calcTotals } from '../pos-money.util';
import { todayVn, vnDayRange } from '../pos-mapper';

const mod = (delta: number) => ({ id: 1, group_name: 'Size', name: 'L', price_delta: delta });

describe('POS tính tiền (số nguyên VND)', () => {
  it('thành tiền = (đơn giá + Σ tuỳ chọn) × số lượng', () => {
    expect(calcLineTotal(35000, [mod(5000), mod(-2000)], 3)).toBe(114000);
  });
  it('đơn giá sau tuỳ chọn âm bị từ chối', () => {
    expect(() => calcLineTotal(1000, [mod(-5000)], 1)).toThrow(BadRequestException);
  });
  it('giảm % làm tròn xuống, giảm tiền không vượt tạm tính', () => {
    expect(calcDiscount(99999, 'percent', 10)).toBe(9999);
    expect(calcDiscount(50000, 'amount', 50000)).toBe(50000);
    expect(() => calcDiscount(50000, 'amount', 50001)).toThrow(BadRequestException);
    expect(() => calcDiscount(50000, 'percent', 101)).toThrow(BadRequestException);
    expect(calcDiscount(50000, 'none', 999)).toBe(0);
  });
  it('tổng = tạm tính − giảm giá', () => {
    expect(calcTotals([30000, 45000], 'percent', 20)).toEqual({ subtotal: 75000, discount_amount: 15000, total: 60000 });
  });
  it('tiền mặt: tính tiền thối; đưa thiếu bị từ chối', () => {
    expect(buildPaymentRows([{ method: 'cash', amount: 60000, tendered: 100000 }], 60000)[0]).toMatchObject({ tendered: 100000, change: 40000 });
    expect(buildPaymentRows([{ method: 'cash', amount: 60000 }], 60000)[0]).toMatchObject({ tendered: 60000, change: 0 });
    expect(() => buildPaymentRows([{ method: 'cash', amount: 60000, tendered: 50000 }], 60000)).toThrow('chưa đủ');
  });
  it('chuyển khoản không có tiền thối, bỏ qua tendered', () => {
    expect(buildPaymentRows([{ method: 'bank_transfer', amount: 60000, tendered: 999999 }], 60000)[0])
      .toMatchObject({ tendered: null, change: 0 });
  });
  it('chia 2 dòng: tổng phải KHỚP chính xác tổng đơn', () => {
    const ok = buildPaymentRows([{ method: 'cash', amount: 20000 }, { method: 'bank_transfer', amount: 40000 }], 60000);
    expect(ok).toHaveLength(2);
    expect(() => buildPaymentRows([{ method: 'cash', amount: 20000 }], 60000)).toThrow(BadRequestException);
    expect(() => buildPaymentRows([{ method: 'cash', amount: 70000 }], 60000)).toThrow(BadRequestException);
  });
  it('đơn 0đ (giảm 100%) thanh toán không cần dòng; đơn > 0 mà rỗng thì lỗi', () => {
    expect(buildPaymentRows([], 0)).toEqual([]);
    expect(() => buildPaymentRows([], 1000)).toThrow(BadRequestException);
  });
  it('số tiền vượt trần / không nguyên bị từ chối', () => {
    expect(() => calcLineTotal(999_999_999_999, [], 999)).toThrow(BadRequestException);
    expect(() => buildPaymentRows([{ method: 'cash', amount: 10.5 }], 10)).toThrow(BadRequestException);
  });
});

describe('POS ngày giờ VN', () => {
  it('todayVn lấy theo UTC+7 (17:30 UTC = sáng hôm sau ở VN)', () => {
    expect(todayVn(new Date('2026-09-30T17:30:00Z'))).toBe('2026-10-01');
    expect(todayVn(new Date('2026-09-30T16:59:00Z'))).toBe('2026-09-30');
  });
  it('vnDayRange = 00:00 VN → 00:00 hôm sau', () => {
    const { from, to } = vnDayRange('2026-09-30');
    expect(from.toISOString()).toBe('2026-09-29T17:00:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(86_400_000);
  });
});
