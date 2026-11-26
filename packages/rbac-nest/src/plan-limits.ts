import { ConflictException } from '@nestjs/common';
import { PLANS, resolvePlan } from '@trinity/rbac';

/** Phần tối thiểu của PrismaClient/tx mà hàm cần — để dùng được cả trong transaction. */
export interface PlanLimitClient {
  setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> };
  user: { count(args: { where: { status: string; deleted_at: null } }): Promise<number> };
}

/** Câu báo khi hết chỗ — dùng chung cho tạo người dùng, mở khoá, tạo lời mời. */
export function userLimitMessage(max: number): string {
  return `Gói hiện tại tối đa ${max} người, liên hệ để nâng gói.`;
}

/**
 * Chặn tạo/kích hoạt thêm user khi đã đủ `max_users` của gói.
 * Đếm user `status='active'` chưa xoá mềm + `reserved` (lời mời còn hiệu lực — mỗi lời mời giữ một chỗ).
 * Gói `custom`/vắng = không giới hạn.
 * Gọi TRƯỚC khi tạo user mới, mở khoá (locked → active) hoặc tạo lời mời.
 */
export async function assertUserSlotAvailable(db: PlanLimitClient, reserved = 0): Promise<void> {
  const row = await db.setting.findUnique({ where: { key: 'org_plan' }, select: { value: true } });
  const plan = resolvePlan(row?.value?.trim());
  const max = PLANS[plan].maxUsers;
  if (max === null) return;
  const active = await db.user.count({ where: { status: 'active', deleted_at: null } });
  if (active + reserved >= max) throw new ConflictException(userLimitMessage(max));
}
