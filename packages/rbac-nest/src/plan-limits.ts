import { ConflictException } from '@nestjs/common';
import { PLANS, resolvePlan } from '@trinity/rbac';

/** Phần tối thiểu của PrismaClient/tx mà hàm cần — để dùng được cả trong transaction. */
export interface PlanLimitClient {
  setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> };
  user: { count(args: { where: { status: string; deleted_at: null } }): Promise<number> };
}

/**
 * Chặn tạo/kích hoạt thêm user khi đã đủ `max_users` của gói.
 * Đếm user `status='active'` chưa xoá mềm. Gói `custom`/vắng = không giới hạn.
 * Gọi TRƯỚC khi tạo user mới hoặc mở khoá (locked → active).
 */
export async function assertUserSlotAvailable(db: PlanLimitClient): Promise<void> {
  const row = await db.setting.findUnique({ where: { key: 'org_plan' }, select: { value: true } });
  const plan = resolvePlan(row?.value?.trim());
  const max = PLANS[plan].maxUsers;
  if (max === null) return;
  const active = await db.user.count({ where: { status: 'active', deleted_at: null } });
  if (active >= max) {
    throw new ConflictException(
      `Gói ${PLANS[plan].label} chỉ cho tối đa ${max} người dùng đang hoạt động (hiện ${active}). Khoá bớt tài khoản hoặc nâng gói để thêm người.`,
    );
  }
}
