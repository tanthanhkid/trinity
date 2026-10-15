import { Prisma } from '@prisma/client';

/**
 * Helper where-clause dùng chung cho các báo cáo AGGREGATE (đếm/groupBy) —
 * `owner` là kết quả `ScopeService.ownerIds(user, <quyền báo cáo>)` của quyền
 * gate ĐÚNG endpoint đang gọi (`reports.overview`/`reports.customers`/...).
 * Owner của mỗi loại tài nguyên ĐỒNG NHẤT mọi vai trò — KHÔNG
 * có nhánh riêng per-role.
 *
 * KHÔNG dùng cho danh sách khách hàng cụ thể (tab Khách hàng của Danh bạ dùng
 * `scopeWhere(user, 'contacts.view')` thật của module Danh bạ).
 */

/** Filter đơn giản `{ in: owner }` cho cột 1 FK thẳng tới User. `'all'` → không lọc. */
export function scopeIdFilter(owner: number[] | 'all'): { in: number[] } | undefined {
  return owner === 'all' ? undefined : { in: owner };
}

/** Where-clause cho `Contact` — owner = `assigned_to` HOẶC `created_by_id`. */
export function buildContactScopeWhere(
  owner: number[] | 'all',
  extra: Prisma.ContactWhereInput = {},
): Prisma.ContactWhereInput {
  const base: Prisma.ContactWhereInput = { deleted_at: null, ...extra };
  if (owner === 'all') return base;
  return { ...base, OR: [{ assigned_to: { in: owner } }, { created_by_id: { in: owner } }] };
}

/** Where-clause cho `Activity` theo phạm vi báo cáo (chỉ 1 chiều `created_by`). */
export function buildActivityScopeWhere(
  owner: number[] | 'all',
  extra: Prisma.ActivityWhereInput = {},
): Prisma.ActivityWhereInput {
  const createdBy = scopeIdFilter(owner);
  return createdBy ? { ...extra, created_by: createdBy } : extra;
}
