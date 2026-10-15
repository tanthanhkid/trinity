import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';
import { makePhoneMasker } from '@trinity/rbac-nest';

/**
 * Kanban đọc quyền `contacts.*` TRỰC TIẾP qua `ScopeService` (không phụ thuộc chéo vào
 * module Danh bạ). Owner của contact = `assigned_to` HOẶC `created_by_id`.
 */

/**
 * Không giữ QUYỀN `contacts.view` nào cả (kể cả scope hẹp nhất) thì không
 * được đụng field `contact_id` trên card — kể cả gán `null` để GỠ liên kết
 * (chạm field này = cần thấy được Danh bạ; ranh giới đơn giản,
 * không phân biệt "link" vs "unlink").
 */
export function assertContactFieldMutable(user: AuthUser): void {
  if (!can(user.grants, 'contacts.view')) {
    throw new ForbiddenException('Bạn không có quyền gắn/gỡ khách hàng trên card');
  }
}

/**
 * Gắn `contact_id` vào card: người thao tác PHẢI xem được contact đó theo
 * đúng phạm vi `contacts.view` — 404 nếu không (KHÔNG lộ "contact tồn tại
 * nhưng bạn không có quyền").
 */
export async function assertContactLinkable(
  prisma: PrismaService,
  scope: ScopeService,
  user: AuthUser,
  contactId: number,
): Promise<void> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, assigned_to: true, created_by_id: true, deleted_at: true },
  });
  // Khách đã xoá mềm coi như không tồn tại (cùng luật với get_contact/list_contacts).
  if (!contact || contact.deleted_at) throw new NotFoundException(`Không tìm thấy khách hàng ID ${contactId}`);
  const owner = await scope.ownerIds(user, 'contacts.view');
  const inScope =
    owner === 'all' ||
    (owner !== null &&
      ((contact.assigned_to != null && owner.includes(contact.assigned_to)) ||
        (contact.created_by_id != null && owner.includes(contact.created_by_id))));
  if (!inScope) throw new NotFoundException(`Không tìm thấy khách hàng ID ${contactId}`);
}

export interface KanbanCardContactDisplay {
  id: number;
  full_name: string | null;
  phone: string;
  masked: boolean;
}

/**
 * Batch-resolve hiển thị contact cho NHIỀU card cùng lúc ("KHÔNG
 * include sâu, KHÔNG N+1").
 *
 * - Không giữ `contacts.view` nào cả: trả `null` cho MỌI contact — "dùng
 *   được Kanban nhưng không gắn/xem được chi tiết khách hàng".
 * - Contact ngoài phạm vi `contacts.view` của actor (hiếm — vd contact bị đổi
 *   `assigned_to` sau khi đã gắn vào card) → `null`, KHÔNG throw (card vẫn
 *   phải render được, chỉ phần khách hàng ẩn).
 * - SĐT che theo quyền `contacts.phone_full` (KHÔNG nới quyền xem SĐT qua
 *   Kanban).
 */
export async function resolveKanbanCardContactDisplays(
  prisma: PrismaService,
  scope: ScopeService,
  user: AuthUser,
  contactIds: number[],
): Promise<Map<number, KanbanCardContactDisplay | null>> {
  const result = new Map<number, KanbanCardContactDisplay | null>();
  const uniqueIds = Array.from(new Set(contactIds.filter((id): id is number => id != null)));
  if (uniqueIds.length === 0) return result;

  if (!can(user.grants, 'contacts.view')) {
    for (const id of uniqueIds) result.set(id, null);
    return result;
  }

  const [contacts, viewOwner, phoneOwner] = await Promise.all([
    prisma.contact.findMany({
      where: { id: { in: uniqueIds }, deleted_at: null },
      select: { id: true, full_name: true, phone: true, assigned_to: true, created_by_id: true },
    }),
    scope.ownerIds(user, 'contacts.view'),
    scope.ownerIds(user, 'contacts.phone_full'),
  ]);
  const maskFn = makePhoneMasker(phoneOwner ?? []);

  for (const contact of contacts) {
    const owners = [contact.assigned_to, contact.created_by_id];
    const canAccess =
      viewOwner === 'all' || (viewOwner !== null && owners.some((o) => o != null && viewOwner.includes(o)));
    if (!canAccess) {
      result.set(contact.id, null);
      continue;
    }
    // `contact.phone` KHÔNG bao giờ null (cột NOT NULL trong schema) — chữ ký
    // dùng chung `makePhoneMasker` khai `string | null` vì phục vụ cả caller
    // khác có input nullable, nên fallback `?? ''` chỉ là ép kiểu, không phải
    // nhánh thực tế sẽ chạy.
    const phone = maskFn(owners, contact.phone) ?? '';
    result.set(contact.id, {
      id: contact.id,
      full_name: contact.full_name,
      phone,
      masked: phone !== contact.phone,
    });
  }
  // Contact ID không tìm thấy (hard-deleted hiếm gặp) → không set gì, caller
  // đọc `map.get(id) ?? null` sẽ tự ra null.
  return result;
}
