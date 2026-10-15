import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService, publishIntegrationEvent, snapshotContact, CONTACT_EVENT_SELECT } from '@trinity/prisma';
import { type AuthUser, ScopeService } from '@trinity/rbac-nest';
import { ActivitiesService } from '../activities/activities.service';

/** Cap 1 lần bulk-transfer (an toàn kết nối DB). */
export const CONTACT_BULK_TRANSFER_MAX = 500;

export interface ContactTransferResult {
  contactId: number;
  fromUserId: number | null;
  toUserId: number;
}

export interface BulkContactTransferResult {
  transferredIds: number[];
  failed: Array<{ contactId: number; error: string }>;
}

/**
 * chuyển quyền phụ trách
 * (Contact.assigned_to) cho người khác trong phạm vi quyền `contacts.transfer`
 * giải quyết "nhiều sale nghỉ việc nhưng khách quan tâm vẫn đứng tên họ
 * trong Danh bạ".
 *
 * Người nhận PHẢI active + nằm trong phạm vi `contacts.transfer` của người
 * gọi (`ScopeService.ownerIds`) — KHÔNG còn đòi hỏi giữ 1 role literal cố
 * định ("sales") như hệ RBAC cũ, ghi Activity làm audit trail.
 *
 * Cũng KHÔNG đụng `PATCH /contacts/:id` (validateAssignmentChange cũ) —
 * endpoint generic đó giữ nguyên hành vi cho mọi role đang dùng nó.
 */
@Injectable()
export class ContactTransferService {
  private readonly logger = new Logger(ContactTransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activitiesService: ActivitiesService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * RBAC quyền + phạm vi — thay switch theo vai trò literal bằng
   * `ScopeService.ownerIds(user, 'contacts.transfer')`. `'all'` = không giới
   * hạn (mirror hành vi `super_admin` cũ); `null` không xảy ra trong luồng
   * bình thường vì `@Can('contacts.transfer')` đã chặn ở controller.
   */
  private async resolveScope(user: AuthUser): Promise<number[] | 'all'> {
    const owner = await this.scope.ownerIds(user, 'contacts.transfer');
    return owner ?? [];
  }

  /**
   * Người nhận PHẢI active + nằm trong phạm vi `contacts.transfer` của người
   * gọi (scope `contacts.transfer`, status='active'). Không đòi hỏi tên vai trò cụ thể.
   */
  private assertActiveInScope(
    target: { id: number; full_name: string; status: string; deleted_at: Date | null } | null,
    allowedIds: number[] | 'all',
  ): { id: number; full_name: string } {
    const isActive = target != null && target.deleted_at === null && target.status === 'active';
    if (!target || !isActive) {
      throw new BadRequestException(
        'Người được chọn không hợp lệ, đã bị khoá hoặc nghỉ việc',
      );
    }
    if (allowedIds !== 'all' && !allowedIds.includes(target.id)) {
      throw new ForbiddenException(
        'Chỉ được chuyển khách hàng cho người thuộc phạm vi contacts.transfer của bạn',
      );
    }
    return { id: target.id, full_name: target.full_name };
  }

  /**
   * Chuyển 1 contact cho sale khác. Ném lỗi (404/403/400) khi không hợp lệ —
   * caller `bulkTransfer` bắt lỗi này per-item.
   */
  async transfer(
    contactId: number,
    newAssignedTo: number,
    reason: string,
    user: AuthUser,
  ): Promise<ContactTransferResult> {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, deleted_at: null },
      select: {
        id: true,
        assigned_to: true,
        full_name: true,
        phone: true,
        assigned_user: { select: { full_name: true } },
      },
    });
    if (!contact) {
      throw new NotFoundException(`Không tìm thấy khách hàng ID ${contactId}`);
    }

    // Contact hiện tại phải có `assigned_to` nằm
    // trong scope `contacts.transfer` của người gọi — không cho "chuyển" 1
    // contact ngoài phạm vi quản lý.
    const allowedIds = await this.resolveScope(user);
    const contactInScope =
      allowedIds === 'all' ||
      (contact.assigned_to != null && allowedIds.includes(contact.assigned_to));
    if (!contactInScope) {
      throw new ForbiddenException('Bạn không có quyền chuyển khách hàng này');
    }

    if (newAssignedTo === contact.assigned_to) {
      throw new BadRequestException(
        'Sale được chọn đang là người phụ trách hiện tại. Không thực hiện cập nhật.',
      );
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: newAssignedTo },
      select: { id: true, full_name: true, status: true, deleted_at: true },
    });
    const target = this.assertActiveInScope(targetUser, allowedIds);

    // Cùng luật trùng SĐT với create/update: người nhận không được có sẵn khách cùng SĐT (409, không lộ số).
    if (contact.phone) {
      const dupe = await this.prisma.contact.count({
        where: { phone: contact.phone, deleted_at: null, id: { not: contact.id }, assigned_to: newAssignedTo },
      });
      if (dupe > 0) {
        throw new ConflictException('Người nhận đã có khách hàng trùng số điện thoại với khách này');
      }
    }

    // đổi người phụ trách + outbox `contact.assigned` CÙNG transaction. Điều kiện `assigned_to` trong
    // where chống 2 lần chuyển song song cùng ghi (lần sau thấy người phụ trách đã đổi → 409, không bắn
    // sự kiện với `from_user_id` cũ).
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.contact.updateMany({
        where: { id: contact.id, deleted_at: null, assigned_to: contact.assigned_to },
        data: { assigned_to: newAssignedTo },
      });
      if (moved.count !== 1) {
        throw new ConflictException('Khách hàng vừa được người khác chuyển, tải lại rồi thử lại');
      }
      const row = await tx.contact.findUniqueOrThrow({ where: { id: contact.id }, select: CONTACT_EVENT_SELECT });
      await publishIntegrationEvent(
        tx,
        'contact.assigned',
        {
          contact: snapshotContact(row),
          from_user_id: contact.assigned_to,
          to_user_id: newAssignedTo,
          reason: reason || null,
        },
        { resourceId: contact.id, actorUserId: user.userId },
      );
    });

    const customerName = contact.full_name?.trim() || `khách hàng #${contact.id}`;
    const previousName = contact.assigned_user?.full_name ?? 'chưa gán';
    await this.activitiesService.create({
      contactId: contact.id,
      action: 'contact_transfer',
      details: {
        description:
          `Chuyển quyền phụ trách khách hàng ${customerName} từ ${previousName} ` +
          `sang ${target.full_name}`,
        reason: reason || null,
      },
      metadata: { from_user_id: contact.assigned_to, to_user_id: newAssignedTo },
      createdBy: user.userId,
    });

    this.logger.log(
      `Contact ${contact.id} transferred: ${contact.assigned_to} -> ${newAssignedTo} by user ${user.userId}`,
    );

    return {
      contactId: contact.id,
      fromUserId: contact.assigned_to,
      toUserId: newAssignedTo,
    };
  }

  /**
   * Bulk: tuần tự per-id (tránh storm connection pool), try/catch từng dòng để 1 liên hệ
   * lỗi không chặn cả lô, MỖI liên hệ ghi Activity RIÊNG (tab Lịch sử của contact cần thấy
   * đúng bản ghi này).
   */
  async bulkTransfer(
    contactIds: number[],
    newAssignedTo: number,
    reason: string,
    user: AuthUser,
  ): Promise<BulkContactTransferResult> {
    const transferredIds: number[] = [];
    const failed: Array<{ contactId: number; error: string }> = [];

    for (const contactId of contactIds) {
      try {
        const result = await this.transfer(contactId, newAssignedTo, reason, user);
        transferredIds.push(result.contactId);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Lỗi không xác định';
        failed.push({ contactId, error: message });
      }
    }

    if (transferredIds.length === 0 && failed.length > 0) {
      throw new BadRequestException(
        `Không chuyển được khách hàng nào. Lỗi đầu tiên: ${failed[0].error}`,
      );
    }

    this.logger.log(
      `Bulk transfer contacts: ${transferredIds.length} success, ${failed.length} failed, by user ${user.userId}`,
    );

    return { transferredIds, failed };
  }

  /**
   * Danh sách nhân sự ACTIVE trong phạm vi `contacts.transfer` cho dropdown —
   * Mẫu D. KHÔNG lọc theo tên vai trò: "được phép nhận chuyển" hoàn toàn do phạm vi
   * quyền `contacts.transfer` quyết định.
   */
  async getAssignableSales(
    user: AuthUser,
  ): Promise<Array<{ id: number; full_name: string; email: string }>> {
    const baseWhere = { deleted_at: null, status: 'active' as const };
    const allowedIds = await this.resolveScope(user);

    if (allowedIds === 'all') {
      return this.prisma.user.findMany({
        where: baseWhere,
        select: { id: true, full_name: true, email: true },
        orderBy: { full_name: 'asc' },
        take: 500,
      });
    }

    if (allowedIds.length === 0) return [];
    return this.prisma.user.findMany({
      where: { ...baseWhere, id: { in: allowedIds } },
      select: { id: true, full_name: true, email: true },
      orderBy: { full_name: 'asc' },
      take: 500,
    });
  }
}
