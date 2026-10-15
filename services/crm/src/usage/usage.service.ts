import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { PLANS } from '@trinity/rbac';
import { OrgFeaturesService } from '../settings/org-features.service';

/**
 * Gói dịch vụ: gói, giới hạn số người dùng, cờ tính năng. KHÔNG có hạn mức AI — Trinity không chạy AI
 * bằng khoá API; AI do agent của khách gọi MCP và khách trả tiền AI theo gói của chính họ.
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  /** Tổng quan cho trang Cài đặt: gói, giới hạn user, số user đang hoạt động, cờ tính năng. */
  async summary() {
    const plan = await this.orgFeatures.getPlan();
    const def = PLANS[plan];
    const [activeUsers, features] = await Promise.all([
      this.prisma.user.count({ where: { status: 'active', deleted_at: null } }),
      this.orgFeatures.get(),
    ]);
    return { plan, plan_label: def.label, max_users: def.maxUsers, active_users: activeUsers, features };
  }
}
