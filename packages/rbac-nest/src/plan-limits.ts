import { ConflictException } from '@nestjs/common';
import { currentCompanyId, isMultiTenant } from '@trinity/prisma';
import { PLANS, resolvePlanForCompany, type PlanKey } from '@trinity/rbac';

/** Khoá advisory tuần tự hoá "đếm chỗ trống rồi thêm người" trong một công ty (khoá đôi: loại khoá + id công ty). */
export const USER_SLOT_LOCK = 726_354_004;

/** Phần tối thiểu của PrismaClient/tx mà hàm cần — chạy TRONG transaction để khoá advisory có tác dụng. */
export interface PlanLimitClient {
  setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> };
  user: { count(args: { where: { status: string; deleted_at: null } }): Promise<number> };
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** Câu báo khi hết chỗ — dùng chung cho tạo người dùng, mở khoá, tạo/nhận lời mời. */
export function userLimitMessage(max: number): string {
  return `Gói hiện tại tối đa ${max} người, liên hệ để nâng gói.`;
}

/** Lấy khoá advisory số chỗ của công ty hiện tại (đến hết transaction). Gọi TRƯỚC khi đụng lời mời / đếm chỗ. */
export async function lockUserSlots(db: Pick<PlanLimitClient, '$executeRaw'>): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${USER_SLOT_LOCK}::int, ${currentCompanyId() ?? 1}::int)`;
}

/**
 * Lời mời "nhận được thật": còn hạn, chưa dùng/huỷ, vai trò còn tồn tại, và người mời còn hoạt động với quyền
 * `users.manage` (vai trò hệ thống hoặc có dòng quyền). Lời mời hỏng (người mời mất quyền/bị khoá, vai trò bị xoá) không giữ chỗ.
 * Bảng gọi không kèm schema nên theo `search_path` của công ty. Điều kiện này dùng cho đếm chỗ và cho trạng thái "hỏng" ở danh sách.
 */
export const USABLE_INVITATION_SQL = `
  i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  AND i.role_id IS NOT NULL AND EXISTS (SELECT 1 FROM roles r0 WHERE r0.id = i.role_id)
  AND EXISTS (
    SELECT 1 FROM users u WHERE u.id = i.created_by AND u.status = 'active' AND u.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'users.manage'
         WHERE ur.user_id = u.id AND (r.is_system OR rp.role_id IS NOT NULL)))`;

/**
 * Gói đang áp cho công ty hiện tại. Có dòng `org_plan` hợp lệ thì theo dòng đó. Thiếu dòng: công ty ≥ 2 của chế độ
 * nhiều công ty coi là gói đăng ký mặc định (có giới hạn); công ty 1 / bản cài một công ty = `custom` (không giới hạn).
 */
export function planFromSetting(raw: string | null | undefined): PlanKey {
  return resolvePlanForCompany(raw?.trim(), isMultiTenant() ? currentCompanyId() : null);
}

/**
 * Chặn thêm/kích hoạt user khi `người active + lời mời đang chờ` đã đạt `maxUsers` của gói (gói `custom` = không giới hạn).
 * PHẢI gọi trong `$transaction` và TRƯỚC khi ghi người mới: hàm lấy khoá advisory của công ty đến hết transaction,
 * nên hai lượt thêm người đồng thời ở ngưỡng chỉ một lượt qua. Mọi đường thêm user active (tạo, mở khoá, nhân viên,
 * nhận/tạo lời mời) dùng đúng hàm này. Lời mời đang xét phải đã được đánh dấu dùng/chưa tạo khi gọi.
 */
export async function assertUserSlotAvailable(db: PlanLimitClient): Promise<void> {
  const row = await db.setting.findUnique({ where: { key: 'org_plan' }, select: { value: true } });
  const max = PLANS[planFromSetting(row?.value)].maxUsers;
  if (max === null) return;
  await lockUserSlots(db);
  const active = await db.user.count({ where: { status: 'active', deleted_at: null } });
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM user_invitations i WHERE ${USABLE_INVITATION_SQL}`);
  const pending = rows[0]?.n ?? 0;
  if (active + pending >= max) throw new ConflictException(userLimitMessage(max));
}
