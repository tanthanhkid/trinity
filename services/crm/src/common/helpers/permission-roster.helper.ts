import type { PrismaService } from '@trinity/prisma';
import type { Permission } from '@trinity/rbac';

/**
 * Danh sách user id (còn hoạt động) đang giữ MỘT quyền không-scoped cụ thể —
 * dùng cho các roster "ai được thông báo/ai đảm nhận việc X" (không dò theo tên
 * vai trò cố định). Vai trò hệ
 * thống "Quản trị" (`is_system=true`) có MỌI quyền nên luôn được cộng vào,
 * không cần dòng `role_permissions` riêng (mirror `PermissionService.
 * adminGrants()`).
 *
 * CHỈ dùng cho quyền `scoped:false` (roster toàn công ty, không phân biệt
 * own/team/subtree/all) — quyền có scope cần trả lời câu khác ("tôi thấy
 * được ai trong scope của TÔI", tức `ScopeService.ownerIds`), không phải câu
 * "ai đang giữ quyền này" mà hàm này trả lời.
 */
export async function findUserIdsWithPermission(
  prisma: PrismaService,
  permission: Permission,
): Promise<number[]> {
  const roles = await prisma.role.findMany({
    where: {
      OR: [{ is_system: true }, { grants: { some: { permission } } }],
    },
    select: { id: true },
  });
  if (roles.length === 0) return [];

  const userRoles = await prisma.userRole.findMany({
    where: {
      role_id: { in: roles.map((r) => r.id) },
      user: { status: 'active', deleted_at: null },
    },
    select: { user_id: true },
  });
  return Array.from(new Set(userRoles.map((ur) => ur.user_id)));
}
