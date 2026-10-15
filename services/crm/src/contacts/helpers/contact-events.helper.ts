import type { Prisma } from '@prisma/client';

/** Tên quan hệ Prisma (khi dùng connect/disconnect) → tên cột trả ra ngoài. */
const RELATION_TO_COLUMN: Record<string, string> = {
  assigned_user: 'assigned_to',
  stage: 'stage_id',
  contact_status: 'contact_status_id',
  team: 'team_id',
  source: 'source_id',
};

/**
 * Danh sách trường THỰC SỰ được ghi trong 1 lần update (đọc từ `data` do `buildUpdateData` dựng bằng các
 * nhánh `!== undefined` — KHÔNG đọc `Object.keys(dto)`, vì DTO ES2022 có mọi key = undefined).
 * Lọc thêm `!== undefined` để chắc chắn dù `data` đến từ nguồn khác.
 */
export function changedContactFields(data: Prisma.ContactUpdateInput): string[] {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => RELATION_TO_COLUMN[k] ?? k)
    .sort();
}
