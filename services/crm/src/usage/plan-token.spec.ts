import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PlanTokenGuard } from './plan-token.guard';
import { PLAN_TOKEN_ENV, verifyPlanToken } from './plan-token';
import { OrgFeaturesService } from '../settings/org-features.service';

describe('verifyPlanToken', () => {
  it('khớp → true', () => expect(verifyPlanToken('abc123', 'abc123')).toBe(true));
  it('sai / khác độ dài / rỗng / không phải chuỗi → false', () => {
    expect(verifyPlanToken('abc124', 'abc123')).toBe(false);
    expect(verifyPlanToken('abc', 'abc123')).toBe(false);
    expect(verifyPlanToken('', 'abc123')).toBe(false);
    expect(verifyPlanToken(undefined, 'abc123')).toBe(false);
    expect(verifyPlanToken(['abc123'], 'abc123')).toBe(false);
  });
  it('server chưa đặt biến → từ chối kể cả token rỗng', () => {
    expect(verifyPlanToken('x', undefined)).toBe(false);
    expect(verifyPlanToken('', '')).toBe(false);
  });
});

describe('PlanTokenGuard', () => {
  const ctx = (headers: Record<string, unknown>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;
  const saved = process.env[PLAN_TOKEN_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[PLAN_TOKEN_ENV];
    else process.env[PLAN_TOKEN_ENV] = saved;
  });
  it('không đặt biến môi trường → 403 cho mọi người', () => {
    delete process.env[PLAN_TOKEN_ENV];
    expect(() => new PlanTokenGuard().canActivate(ctx({ 'x-trinity-plan-token': 'abc' }))).toThrow(ForbiddenException);
  });
  it('thiếu / sai header → 403; đúng → qua', () => {
    process.env[PLAN_TOKEN_ENV] = 'secret-token';
    const g = new PlanTokenGuard();
    expect(() => g.canActivate(ctx({}))).toThrow(ForbiddenException);
    expect(() => g.canActivate(ctx({ 'x-trinity-plan-token': 'nope' }))).toThrow(ForbiddenException);
    expect(g.canActivate(ctx({ 'x-trinity-plan-token': 'secret-token' }))).toBe(true);
  });
});

describe('OrgFeaturesService.setPlan — nhật ký', () => {
  it('ghi Setting + audit_logs trong cùng giao dịch', async () => {
    const tx = { setting: { upsert: jest.fn() }, auditLog: { create: jest.fn() } };
    const prisma = {
      setting: { findUnique: jest.fn().mockResolvedValue({ value: 'ket_noi' }) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };
    const svc = new OrgFeaturesService(prisma as never);
    await svc.setPlan('tro_ly_giam_doc', 7, 'api', '1.2.3.4');
    expect(tx.setting.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { value: 'tro_ly_giam_doc', updated_by: 7 } }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 7,
        resource: 'org_plan',
        metadata: { from: 'ket_noi', to: 'tro_ly_giam_doc', source: 'api' },
      }),
    });
  });
});
