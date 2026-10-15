import type { Prisma } from '@trinity/prisma';
import { scopeWhere } from '@trinity/rbac-nest';

/** Owner của khách/thương vụ — CÙNG trường với danh sách Danh bạ/Deal. */
export const CONTACT_OWNER_FIELDS = ['assigned_to', 'created_by_id'];
export const DEAL_OWNER_FIELDS = ['assigned_to', 'created_by'];

/**
 * Phạm vi KPI Tổng quan = phạm vi quyền `reports.overview` (own|team|subtree|all)
 * `'all'` = không giới hạn;
 * mảng rỗng = KHÔNG ai (không tự nới). Compose bằng `AND` (không spread).
 */
export function buildContactScope(owner: number[] | 'all'): Prisma.ContactWhereInput {
  return { AND: [scopeWhere(owner, CONTACT_OWNER_FIELDS) as Prisma.ContactWhereInput, { deleted_at: null }] };
}

/** Phạm vi thương vụ — mirror `DealsService` (`assigned_to` | `created_by`). */
export function buildDealScope(owner: number[] | 'all'): Prisma.DealWhereInput {
  return scopeWhere(owner, DEAL_OWNER_FIELDS) as Prisma.DealWhereInput;
}

/**
 * Deal ở trạng thái `status` trong khoảng [start, end): `won` tính theo NGÀY THẮNG (`won_at`, đặt lúc chuyển sang won);
 * deal thắng từ trước khi có cột (won_at NULL) rơi về `updated_at`. `lost` chưa có cột riêng nên dùng `updated_at`.
 */
export function dealStatusInRange(
  status: 'won' | 'lost',
  r: { start: Date; end?: Date },
): Prisma.DealWhereInput {
  const range = { gte: r.start, ...(r.end ? { lt: r.end } : {}) };
  if (status !== 'won') return { status, updated_at: range };
  return { status, OR: [{ won_at: range }, { won_at: null, updated_at: range }] };
}
