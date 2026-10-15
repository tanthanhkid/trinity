import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RBAC_META } from '@trinity/rbac-nest';
import { UsageService } from './usage.service';
import { UsageController } from './usage.controller';
import { PlanTokenGuard } from './plan-token.guard';
import { OrgFeatureGuard, ORG_FEATURE_META, RequireOrgFeature } from './org-feature.guard';

const make = (plan: string | null) => {
  const prisma = {
    setting: { findUnique: jest.fn().mockResolvedValue(plan ? { value: plan } : null) },
    user: { count: jest.fn().mockResolvedValue(3) },
  };
  const orgFeatures = {
    getPlan: jest.fn().mockResolvedValue(plan ?? 'custom'),
    get: jest.fn().mockResolvedValue({}),
    isEnabled: jest.fn(),
  };
  return { svc: new UsageService(prisma as never, orgFeatures as never), prisma, orgFeatures };
};

describe('UsageService', () => {
  it('summary đủ trường cho trang Cài đặt, không còn hạn mức AI', async () => {
    const s = await make('tro_ly_kinh_doanh').svc.summary();
    expect(s).toMatchObject({ plan: 'tro_ly_kinh_doanh', max_users: 30, active_users: 3 });
    expect(s).not.toHaveProperty('usage');
  });
});

describe('OrgFeatureGuard', () => {
  const ctx = (handler: () => void) =>
    ({ getHandler: () => handler, getClass: () => class {} }) as unknown as ExecutionContext;
  it('không gắn cờ → qua', async () => {
    const g = new OrgFeatureGuard(new Reflector(), { isEnabled: jest.fn() } as never);
    expect(await g.canActivate(ctx(() => undefined))).toBe(true);
  });
  it('cờ tắt → 403 tiếng Việt; bật → qua', async () => {
    class C {
      @RequireOrgFeature('zalo_oa')
      h() {}
    }
    const handler = C.prototype.h;
    expect(Reflect.getMetadata(ORG_FEATURE_META, handler)).toBe('zalo_oa');
    const off = new OrgFeatureGuard(new Reflector(), { isEnabled: jest.fn().mockResolvedValue(false) } as never);
    await expect(off.canActivate(ctx(handler))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(off.canActivate(ctx(handler))).rejects.toThrow('Zalo OA');
    const on = new OrgFeatureGuard(new Reflector(), { isEnabled: jest.fn().mockResolvedValue(true) } as never);
    expect(await on.canActivate(ctx(handler))).toBe(true);
  });
});

describe('UsageController RBAC', () => {
  const meta = (m: keyof UsageController) =>
    Reflect.getMetadata(RBAC_META, UsageController.prototype[m] as unknown as () => void);
  it('chỉ admin (settings.features)', () => {
    expect(meta('summary')).toEqual({ kind: 'can', permissions: ['settings.features'], mode: 'all' });
    expect(meta('setPlan')).toEqual({ kind: 'can', permissions: ['settings.features'], mode: 'all' });
  });
  it('setPlan gắn PlanTokenGuard', () => {
    const guards = Reflect.getMetadata('__guards__', UsageController.prototype.setPlan) as unknown[];
    expect(guards).toContain(PlanTokenGuard);
  });
  it('gói không hợp lệ → 400', async () => {
    const c = new UsageController({} as never, {} as never);
    await expect(c.setPlan({ plan: 'vip' }, { userId: 1 } as never, {})).rejects.toThrow('Gói không hợp lệ');
  });
});
