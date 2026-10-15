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
    expect(err.message).toContain('tối đa 10 người dùng');
  });
  it('rác trong settings = custom', async () => {
    await expect(assertUserSlotAvailable(db('???', 500))).resolves.toBeUndefined();
  });
});
