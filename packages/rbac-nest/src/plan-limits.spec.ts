import { ConflictException } from '@nestjs/common';
import { runWithCompany } from '@trinity/prisma';
import { DEFAULT_SIGNUP_PLAN, PLANS } from '@trinity/rbac';
import { assertUserSlotAvailable, planFromSetting, type PlanLimitClient } from './plan-limits';

const db = (plan: string | null, active: number, pending = 0): PlanLimitClient => ({
  setting: { findUnique: jest.fn().mockResolvedValue(plan === null ? null : { value: plan }) },
  user: { count: jest.fn().mockResolvedValue(active) },
  userInvitation: { count: jest.fn().mockResolvedValue(pending) },
  $executeRaw: jest.fn().mockResolvedValue(1),
});

describe('assertUserSlotAvailable', () => {
  it('bản một công ty chưa đặt gói = custom: không giới hạn, không khoá, không đếm', async () => {
    const d = db(null, 9999);
    await expect(assertUserSlotAvailable(d)).resolves.toBeUndefined();
    expect(d.user.count).not.toHaveBeenCalled();
    expect(d.$executeRaw).not.toHaveBeenCalled();
  });
  it('gói Kết nối: 9/10 còn chỗ, 10/10 báo lỗi tiếng Việt; lấy khoá advisory trước khi đếm', async () => {
    const ok = db('ket_noi', 9);
    await expect(assertUserSlotAvailable(ok)).resolves.toBeUndefined();
    expect(ok.$executeRaw).toHaveBeenCalledTimes(1);
    const err = await assertUserSlotAvailable(db('ket_noi', 10)).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('Gói hiện tại tối đa 10 người, liên hệ để nâng gói.');
  });
  it('lời mời còn hiệu lực giữ chỗ ở MỌI đường: 8 người + 2 lời mời = đủ gói 10', async () => {
    await expect(assertUserSlotAvailable(db('ket_noi', 8, 1))).resolves.toBeUndefined();
    await expect(assertUserSlotAvailable(db('ket_noi', 8, 2))).rejects.toBeInstanceOf(ConflictException);
  });
  it('gói tuỳ biến (đặt tay) không giới hạn; rác trong settings ở bản một công ty = custom', async () => {
    await expect(assertUserSlotAvailable(db('custom', 500, 500))).resolves.toBeUndefined();
    await expect(assertUserSlotAvailable(db('???', 500))).resolves.toBeUndefined();
  });
});

describe('planFromSetting — công ty mới thiếu dòng gói không thành "không giới hạn"', () => {
  const prev = process.env.MULTI_TENANT;
  afterEach(() => {
    process.env.MULTI_TENANT = prev;
  });
  it('nhiều công ty: công ty ≥ 2 thiếu/rác = gói đăng ký mặc định có giới hạn; công ty 1 = custom; dòng hợp lệ thắng', () => {
    process.env.MULTI_TENANT = 'true';
    expect(PLANS[DEFAULT_SIGNUP_PLAN].maxUsers).not.toBeNull();
    runWithCompany({ id: 3, schema: 'c_3' }, () => {
      expect(planFromSetting(undefined)).toBe(DEFAULT_SIGNUP_PLAN);
      expect(planFromSetting('???')).toBe(DEFAULT_SIGNUP_PLAN);
      expect(planFromSetting('custom')).toBe('custom');
      expect(planFromSetting('tro_ly_van_hanh')).toBe('tro_ly_van_hanh');
    });
    runWithCompany({ id: 1, schema: 'public' }, () => expect(planFromSetting(undefined)).toBe('custom'));
  });
  it('một công ty (MULTI_TENANT=false): thiếu dòng = custom', () => {
    process.env.MULTI_TENANT = 'false';
    expect(planFromSetting(undefined)).toBe('custom');
  });
});
