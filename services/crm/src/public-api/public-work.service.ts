import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import { PermissionService, ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { DealsService } from '../deals/deals.service';
import { KanbanCardsService } from '../kanban/cards/kanban-cards.service';
import { buildKanbanBoardVisibilityWhere, loadKanbanAccessContext, loadVisibleBoardOrNotFound } from '../kanban/common/kanban-rbac.helper';
import { validateKanbanAttributes } from '../kanban/common/kanban-field.validator';
import { normalizePhone, phoneVariants } from '../google/sheet-mapping';
import type { ValidatedApiKey } from './api-key.guard';
import { PublicApiService } from './public-api.service';
import type { PublicCreateDealDto, PublicCreateTaskDto } from './dto/public-work.dto';

/**
 * Thao tác ghi cơ bản qua khoá API cho Zapier / n8n / Make: tạo thương vụ (đơn), tạo việc (thẻ Kanban).
 * Chạy DƯỚI DANH NGHĨA người giữ khoá (`owner_user_id`) với đúng quyền + phạm vi dữ liệu của người đó —
 * gọi lại service nghiệp vụ như màn web, không có đường tắt. Khoá chỉ quyết định ĐƯỢC GỌI endpoint nào (scope).
 */
@Injectable()
export class PublicWorkService {
  private readonly logger = new Logger(PublicWorkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
    private readonly deals: DealsService,
    private readonly cards: KanbanCardsService,
    private readonly contacts: PublicApiService,
  ) {}

  /** Người giữ khoá dưới dạng `AuthUser` (quyền tính lại mỗi lần — đổi vai trò là có hiệu lực ngay). */
  async actor(apiKey: ValidatedApiKey): Promise<AuthUser> {
    const u = await this.prisma.user.findUnique({ where: { id: apiKey.owner_user_id }, select: { id: true, email: true, status: true } });
    if (!u || u.status !== 'active') throw new BadRequestException('Người giữ khoá API không còn hoạt động. Liên hệ quản trị viên.');
    const { grants, isAdmin } = await this.permissions.grantsFor(u.id);
    // Khoá không được cấp cho Quản trị (Auth chặn lúc tạo); chủ khoá được nâng lên Quản trị SAU đó thì chặn luôn,
    // không để khoá bên ngoài âm thầm thành khoá toàn quyền.
    if (isAdmin) throw new ForbiddenException('Chủ khoá API hiện là Quản trị — khoá bị chặn. Tạo khoá mới với tài khoản nhân viên có đúng quyền cần dùng.');
    return { userId: u.id, email: u.email, isAdmin, grants };
  }

  private need(user: AuthUser, permission: Parameters<typeof can>[1], label: string): void {
    if (!user.isAdmin && !can(user.grants, permission)) throw new ForbiddenException(`Người giữ khoá không có quyền ${label}.`);
  }

  /**
   * Khách gắn kèm: tìm theo SĐT trong phạm vi `contacts.view` của người giữ khoá; không thấy thì tạo mới khi có `contact_name`
   * (cần quyền `contacts.create`). Không gửi SĐT ⇒ không gắn khách.
   */
  async resolveContact(user: AuthUser, ref: { contact_phone?: string; contact_name?: string; contact_source_id?: number }): Promise<{ id: number; created: boolean } | null> {
    if (!ref.contact_phone) return null;
    const phone = normalizePhone(ref.contact_phone) ?? ref.contact_phone;
    const owners = await this.scope.ownerIds(user, 'contacts.view');
    if (owners !== null) {
      const found = await this.prisma.contact.findFirst({
        where: {
          phone: { in: phoneVariants(phone) },
          deleted_at: null,
          ...(owners === 'all' ? {} : { OR: [{ assigned_to: { in: owners } }, { created_by_id: { in: owners } }] }),
        },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      if (found) return { id: found.id, created: false };
    }
    if (!ref.contact_name?.trim()) throw new BadRequestException('Không tìm thấy khách có SĐT này. Gửi thêm contact_name để tạo khách mới.');
    this.need(user, 'contacts.create', 'tạo khách hàng');
    if (ref.contact_source_id != null) {
      const opt = await this.prisma.settingOption.findUnique({ where: { id: ref.contact_source_id }, select: { group_key: true, is_active: true } });
      if (!opt || opt.group_key !== 'contact_source' || !opt.is_active) throw new BadRequestException(`contact_source_id ${ref.contact_source_id} không phải nguồn khách đang bật`);
    }
    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: { id: true, team_id: true } });
    const c = await this.prisma.$transaction((tx) =>
      this.contacts.createContactInTx(tx, { phone, full_name: ref.contact_name!.trim(), source_id: ref.contact_source_id ?? null }, owner, 'public_api'),
    );
    return { id: c.id, created: true };
  }

  async createDeal(dto: PublicCreateDealDto, apiKey: ValidatedApiKey) {
    const user = await this.actor(apiKey);
    this.need(user, 'deals.manage', 'tạo thương vụ');
    const contact = await this.resolveContact(user, dto);
    const deal = await this.deals.create(
      { title: dto.title, description: dto.description, value: dto.value, status: dto.status, note: dto.note, assigned_to: user.userId, contact_id: contact?.id },
      user,
    );
    this.logger.log(`PublicApi deal created api_key=${apiKey.id} owner=${user.userId} contact_created=${contact?.created ?? false}`);
    return { deal, contact_id: contact?.id ?? null, contact_created: contact?.created ?? false };
  }

  async createTask(dto: PublicCreateTaskDto, apiKey: ValidatedApiKey) {
    const user = await this.actor(apiKey);
    this.need(user, 'kanban.manage', 'tạo việc trên bảng Kanban');
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    // Kiểm cột/bảng/field bắt buộc TRƯỚC khi có thể tạo khách mới — lỗi ở đây không để lại khách thừa.
    const column = await this.prisma.kanbanColumn.findUnique({ where: { id: dto.column_id }, select: { board_id: true, is_archived: true } });
    if (!column) throw new BadRequestException('column_id không hợp lệ');
    await loadVisibleBoardOrNotFound(this.prisma, user, access, column.board_id);
    if (column.is_archived) throw new BadRequestException('Cột đã ẩn — không thể tạo việc vào đây');
    const defs = await this.prisma.kanbanFieldDef.findMany({ where: { board_id: column.board_id }, select: { key: true, label: true, type: true, options: true, required: true } });
    validateKanbanAttributes(defs, dto.attributes ?? {});
    const contact = await this.resolveContact(user, dto);
    const card = await this.cards.create(user, access, {
      column_id: dto.column_id,
      title: dto.title,
      description: dto.description ?? null,
      due_at: dto.due_at ?? null,
      priority: dto.priority ?? null,
      labels: dto.labels,
      attributes: dto.attributes,
      contact_id: contact?.id ?? null,
      assignee_id: user.userId,
    });
    this.logger.log(`PublicApi task created api_key=${apiKey.id} owner=${user.userId}`);
    return { task: card, contact_id: contact?.id ?? null, contact_created: contact?.created ?? false };
  }

  /** Bảng + cột Kanban người giữ khoá được thấy — để điền `column_id` trong Zapier/n8n. */
  async columns(apiKey: ValidatedApiKey) {
    const user = await this.actor(apiKey);
    this.need(user, 'kanban.view', 'xem bảng Kanban');
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    const boards = await this.prisma.kanbanBoard.findMany({
      where: buildKanbanBoardVisibilityWhere(user, access),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        columns: { where: { is_archived: false }, orderBy: { position: 'asc' }, select: { id: true, name: true } },
        field_defs: { orderBy: { position: 'asc' }, select: { key: true, label: true, type: true, options: true, required: true } },
      },
    });
    return { data: boards.map((b) => ({ board_id: b.id, board: b.name, columns: b.columns.map((c) => ({ column_id: c.id, name: c.name })), fields: b.field_defs })) };
  }
}
