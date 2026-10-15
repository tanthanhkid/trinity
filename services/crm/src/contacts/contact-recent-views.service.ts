import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { type AuthUser, ScopeService, assertInScope } from '@trinity/rbac-nest';

/** Tối đa số dòng giữ lại/user — bảng chỉ phục vụ "Khách gần đây" ở sidebar,
 *  không cần lịch sử vô hạn. */
const RECENT_VIEW_CAP_PER_USER = 20;
const DEFAULT_RECENT_LIMIT = 5;
const MAX_RECENT_LIMIT = 10;

export interface RecentContactItem {
  id: number;
  full_name: string | null;
  viewed_at: Date;
}

/**
 * "KHÁCH GẦN ĐÂY" ở sidebar.
 *
 * RBAC quyền + phạm vi: mirror gate TRANG CHI TIẾT (`contacts.view`
 * qua `assertInScope`), KHÔNG mirror gate LIST (`scopeWhere`) — đúng nguyên
 * tắc: endpoint con của 1 resource phải gọi
 * lại ĐÚNG gate của trang chi tiết, không tự suy scope riêng. RBAC được đánh
 * giá LẠI tại THỜI ĐIỂM ĐỌC (`listRecent`), KHÔNG tin bảng
 * `contact_recent_views` là nguồn quyền — contact có thể đã bị chuyển chủ/xoá
 * mềm sau khi user xem lần trước. Ngoài phạm vi → rỗng/bỏ qua dòng đó (KHÔNG
 * lộ id tồn tại hay không qua sidebar).
 */
@Injectable()
export class ContactRecentViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** Ghi nhận user vừa mở trang chi tiết 1 khách hàng. 404 nếu ngoài phạm vi
   *  `contacts.view` — cùng ngữ nghĩa gate trang chi tiết (id đến từ URL). */
  async recordView(user: AuthUser, contactId: number): Promise<void> {
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { assigned_to: true, created_by_id: true },
    });
    if (!contact) throw new NotFoundException(`Không tìm thấy khách hàng ID ${contactId}`);

    await assertInScope(this.scope, user, 'contacts.view', [
      contact.assigned_to,
      contact.created_by_id,
    ]);

    await this.prisma.contactRecentView.upsert({
      where: { user_id_contact_id: { user_id: user.userId, contact_id: contactId } },
      create: { user_id: user.userId, contact_id: contactId },
      update: { viewed_at: new Date() },
    });

    // Giữ tối đa RECENT_VIEW_CAP_PER_USER dòng/user — xoá dòng cũ vượt trần.
    await this.prisma.$executeRaw`
      DELETE FROM contact_recent_views
      WHERE user_id = ${user.userId}
        AND id NOT IN (
          SELECT id FROM contact_recent_views
          WHERE user_id = ${user.userId}
          ORDER BY viewed_at DESC
          LIMIT ${RECENT_VIEW_CAP_PER_USER}
        )
    `;
  }

  /** Danh sách khách gần đây, ĐÃ LỌC theo quyền HIỆN TẠI (`contacts.view`) —
   *  không có quyền này thì rỗng (deny-by-default, đã gate ở `@Can` controller
   *  nhưng service tự phòng thủ), KHÔNG hiện SĐT (chỉ id + tên). */
  async listRecent(user: AuthUser, limit?: number): Promise<RecentContactItem[]> {
    const take = Math.min(Math.max(limit ?? DEFAULT_RECENT_LIMIT, 1), MAX_RECENT_LIMIT);
    const views = await this.prisma.contactRecentView.findMany({
      where: { user_id: user.userId },
      orderBy: { viewed_at: 'desc' },
      take: RECENT_VIEW_CAP_PER_USER,
    });
    if (views.length === 0) return [];

    const contacts = await this.prisma.contact.findMany({
      where: { id: { in: views.map((v) => v.contact_id) } },
      select: {
        id: true,
        full_name: true,
        deleted_at: true,
        assigned_to: true,
        created_by_id: true,
      },
    });
    const contactMap = new Map(contacts.map((c) => [c.id, c]));
    const owner = await this.scope.ownerIds(user, 'contacts.view');

    const result: RecentContactItem[] = [];
    for (const view of views) {
      const contact = contactMap.get(view.contact_id);
      if (!contact || contact.deleted_at) continue;
      const inScope =
        owner === 'all' ||
        (Array.isArray(owner) &&
          [contact.assigned_to, contact.created_by_id].some((id) => id != null && owner.includes(id)));
      if (!inScope) continue;
      result.push({ id: contact.id, full_name: contact.full_name, viewed_at: view.viewed_at });
      if (result.length >= take) break;
    }
    return result;
  }
}
