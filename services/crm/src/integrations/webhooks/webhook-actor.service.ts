import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import { PermissionService, ScopeService, type AuthUser } from '@trinity/rbac-nest';
import type { ActorScopes } from './webhook-payload';

/**
 * "Chủ thể" của endpoint = `created_by` (người tạo / sửa URL-sự kiện gần nhất). Payload gửi đi KHÔNG BAO GIỜ
 * rộng hơn quyền của chủ thể ( "không cấp thứ mình không có"). Trả `null` khi chủ thể không còn đủ
 * điều kiện (bị khoá/xoá, hoặc mất quyền `integrations.webhooks`) ⇒ endpoint phải ngừng gửi.
 * Quyền đọc qua `PermissionService.grantsFor` (DB/cache có Redis invalidate), KHÔNG từ JWT.
 */
@Injectable()
export class WebhookActorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
  ) {}

  async scopesFor(userId: number): Promise<ActorScopes | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true, deleted_at: true },
    });
    if (!user || user.status !== 'active' || user.deleted_at !== null) return null;
    const { grants, isAdmin } = await this.permissions.grantsFor(userId);
    if (!can(grants, 'integrations.webhooks')) return null;
    const au: AuthUser = { userId, email: user.email, isAdmin, grants };
    const [contactsView, dealsView, posSell, phoneFull, customView, customPhoneFull, roles] = await Promise.all([
      this.scope.ownerIds(au, 'contacts.view'),
      this.scope.ownerIds(au, 'deals.view'),
      this.scope.ownerIds(au, 'pos.sell'),
      this.scope.ownerIds(au, 'contacts.phone_full'),
      this.scope.ownerIds(au, 'custom_records.view'),
      this.scope.ownerIds(au, 'custom_records.phone_full'),
      this.prisma.userRole.findMany({ where: { user_id: userId }, select: { role_id: true } }),
    ]);
    return {
      contactsView, dealsView, posSell, phoneFull, customView, customPhoneFull,
      roleIds: roles.map((r) => r.role_id),
      canManageCustomObjects: can(grants, 'custom_objects.manage'),
      canSocialPost: can(grants, 'social.post'),
    };
  }
}
