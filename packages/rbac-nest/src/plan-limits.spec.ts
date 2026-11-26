import { ConflictException } from '@nestjs/common';
import { assertUserSlotAvailable, type PlanLimitClient } from './plan-limits';

const db = (plan: string | null, active: number): PlanLimitClient => ({
  setting: { findUnique: jest.fn().mockResolvedValue(plan === null ? null : { value: plan }) },
  user: { count: jest.fn().mockResolvedValue(active) },
});

describe('assertUserSlotAvailable', () => {
  it('chưa đặt gói = custom: không giới hạn, không cả đếm user', async () => {
    const d = db(null, 9999);
    await expect(assertUserSlotAvailable(d)).resolves.toBeUndefined();
    expect(d.user.count).not.toHaveBeenCalled();
  });
  it('gói Kết nối: 9/10 còn chỗ, 10/10 báo lỗi tiếng Việt', async () => {
    await expect(assertUserSlotAvailable(db('ket_noi', 9))).resolves.toBeUndefined();
    const err = await assertUserSlotAvailable(db('ket_noi', 10)).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('Gói hiện tại tối đa 10 người, liên hệ để nâng gói.');
  });
  it('lời mời còn hiệu lực giữ chỗ: 8 người + 2 lời mời = đủ gói 10', async () => {
    await expect(assertUserSlotAvailable(db('ket_noi', 8), 1)).resolves.toBeUndefined();
    await expect(assertUserSlotAvailable(db('ket_noi', 8), 2)).rejects.toBeInstanceOf(ConflictException);
  });
  it('rác trong settings = custom', async () => {
    await expect(assertUserSlotAvailable(db('???', 500))).resolves.toBeUndefined();
  });
});
