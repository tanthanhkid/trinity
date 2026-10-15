import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PLAN_TOKEN_ENV, PLAN_TOKEN_HEADER, verifyPlanToken } from './plan-token';

/** Chặn đổi gói nếu thiếu/sai `X-Trinity-Plan-Token`; chưa đặt biến môi trường → 403 cho mọi người. */
@Injectable()
export class PlanTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    if (!verifyPlanToken(req.headers?.[PLAN_TOKEN_HEADER], process.env[PLAN_TOKEN_ENV])) {
      throw new ForbiddenException('Chỉ Trinity đổi được gói dịch vụ. Liên hệ Trinity để nâng/hạ gói.');
    }
    return true;
  }
}
