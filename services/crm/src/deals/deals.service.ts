import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService, publishIntegrationEvent, snapshotDeal } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import {
  type AuthUser,
  ScopeService,
  scopeWhere,
  assertInScope,
  makePhoneMasker,
} from '@trinity/rbac-nest';
import { CreateDealDto } from './dto/create-deal.dto';
import { UpdateDealDto } from './dto/update-deal.dto';
import { QueryDealDto } from './dto/query-deal.dto';
import { NotificationsService } from '../notifications/notifications.service';

/** Owner của Deal: `['assigned_to', 'created_by']`. */
const DEAL_OWNER_FIELDS = ['assigned_to', 'created_by'];

const DEAL_SELECT = {
  id: true,
  code: true,
  title: true,
  description: true,
  value: true,
  status: true,
  note: true,
  assigned_to: true,
  created_by: true,
  contact_id: true,
  created_at: true,
  updated_at: true,
  assignee: { select: { id: true, full_name: true, email: true } },
  creator: { select: { id: true, full_name: true, email: true } },
  contact: { select: { id: true, full_name: true, phone: true, assigned_to: true, created_by_id: true } },
} as const;

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * RBAC quyền + phạm vi: che `contact.phone` PER-DÒNG theo
   * phạm vi `contacts.phone_full` của người xem, khoá theo OWNER CỦA CONTACT
   * (`assigned_to`/`created_by_id`) — đúng owner mà `ContactsService` dùng,
   * để 1 SĐT không lộ qua deal khi màn Khách hàng che nó.
   */
  private async maskDealPhone<T extends { assigned_to: number; created_by: number; contact: { phone: string | null; assigned_to: number | null; created_by_id: number | null } | null }>(
    user: AuthUser,
    rows: T[],
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const phoneFullOwners = await this.scope.ownerIds(user, 'contacts.phone_full');
    const mask = makePhoneMasker(phoneFullOwners ?? []);
    return rows.map((r) => {
      if (!r.contact) return r;
      return {
        ...r,
        contact: { ...r.contact, phone: mask([r.contact.assigned_to, r.contact.created_by_id], r.contact.phone) },
      };
    });
  }

  /**
   * RBAC quyền + phạm vi — 2 kiểm tra tổng quát theo phạm vi (không ràng buộc theo tên vai trò):
   * 1. Người được giao (`assigned_to`) phải active + nằm trong phạm vi
   *    `deals.manage` của người tạo (mirror `ContactTransferService`).
   * 2. `contact_id` (nếu có) phải nằm trong phạm vi `contacts.view` của người
   *    tạo — chặn việc gắn deal vào 1 contact mình không được xem để đọc ké
   *    PII qua response `GET /deals/:id`.
   */
  async create(dto: CreateDealDto, user: AuthUser) {
    const managerScope = await this.scope.ownerIds(user, 'deals.manage');
    if (managerScope !== 'all' && !(managerScope ?? []).includes(dto.assigned_to)) {
      throw new ForbiddenException('Không có quyền tạo thương vụ cho người này');
    }

    const assignee = await this.prisma.user.findFirst({
      where: { id: dto.assigned_to, status: 'active' },
      select: { id: true, full_name: true, email: true },
    });
    if (!assignee) {
      throw new BadRequestException(
        'Không tìm thấy nhân viên với ID này hoặc tài khoản không hoạt động',
      );
    }

    if (dto.contact_id != null) {
      const contact = await this.prisma.contact.findUnique({
        where: { id: dto.contact_id },
        select: { assigned_to: true, created_by_id: true },
      });
      if (!contact) {
        throw new BadRequestException('Không tìm thấy khách hàng với ID này');
      }
      await assertInScope(this.scope, user, 'contacts.view', [
        contact.assigned_to,
        contact.created_by_id,
      ]);
    }

    // tạo deal + outbox CÙNG transaction. Deal tạo thẳng ở `won`/`lost` cũng bắn `deal.won`/`deal.lost`.
    const deal = await this.prisma.$transaction(async (tx) => {
      const created = await tx.deal.create({
        data: {
          title: dto.title,
          description: dto.description,
          value: dto.value != null ? BigInt(dto.value) : null,
          status: dto.status ?? 'open',
          // Ngày thắng = lúc chuyển sang won (deal tạo thẳng ở won thì là lúc tạo).
          won_at: dto.status === 'won' ? new Date() : null,
          note: dto.note,
          assigned_to: dto.assigned_to,
          created_by: user.userId,
          contact_id: dto.contact_id ?? null,
        },
        select: DEAL_SELECT,
      });
      const opts = { resourceId: created.id, actorUserId: user.userId };
      await publishIntegrationEvent(tx, 'deal.created', { deal: snapshotDeal(created) }, opts);
      if (created.status === 'won' || created.status === 'lost') {
        await publishIntegrationEvent(tx, `deal.${created.status}`, { deal: snapshotDeal(created) }, opts);
      }
      return created;
    });

    this.notificationsService
      .notifyDealAssigned({
        dealId: deal.id,
        dealTitle: deal.title,
        saleUserId: dto.assigned_to,
        creatorName: user.email ?? `Admin #${user.userId}`,
        contactId: deal.contact_id ?? null,
      })
      .catch((err: unknown) => {
        this.logger.error(
          `notify deal.assigned failed: deal=${deal.id} sale=${dto.assigned_to} err=${String(err)}`,
        );
      });

    this.logger.log(
      `deal.created: id=${deal.id} by=${user.userId} assigned=${dto.assigned_to}`,
    );
    const [masked] = await this.maskDealPhone(user, [deal]);
    return { ...masked, value: masked.value !== null ? Number(masked.value) : null };
  }

  /** Mẫu A — list theo phạm vi `deals.view`. */
  async findAll(query: QueryDealDto, user: AuthUser) {
    const limit = query.limit ?? 20;
    const owner = await this.scope.ownerIds(user, 'deals.view');
    const rbacFilter = scopeWhere(owner ?? [], DEAL_OWNER_FIELDS);

    const and: Prisma.DealWhereInput[] = [rbacFilter];
    if (query.status) and.push({ status: query.status });
    if (query.search) and.push({ title: { contains: query.search, mode: 'insensitive' } });
    if (query.assigned_to !== undefined) and.push({ assigned_to: query.assigned_to });
    const where: Prisma.DealWhereInput = { AND: and };

    const rows = await this.prisma.deal.findMany({
      where,
      take: limit + 1,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: DEAL_SELECT,
    });

    let next_cursor: number | null = null;
    if (rows.length > limit) {
      rows.pop();
      next_cursor = rows[rows.length - 1]?.id ?? null;
    }

    const masked = await this.maskDealPhone(user, rows);
    return {
      data: masked.map((r) => ({
        ...r,
        value: r.value !== null ? Number(r.value) : null,
      })),
      meta: { next_cursor },
    };
  }

  /** Mẫu B — chi tiết, ngoài phạm vi `deals.view` → 404. */
  async findOne(id: number, user: AuthUser) {
    const deal = await this.prisma.deal.findUnique({
      where: { id },
      select: DEAL_SELECT,
    });
    if (!deal) throw new NotFoundException('Không tìm thấy thương vụ');
    await assertInScope(this.scope, user, 'deals.view', [deal.assigned_to, deal.created_by]);
    const [masked] = await this.maskDealPhone(user, [deal]);
    return { ...masked, value: masked.value !== null ? Number(masked.value) : null };
  }

  /** Mẫu B — sửa, ngoài phạm vi `deals.manage` → 404. */
  async update(id: number, dto: UpdateDealDto, user: AuthUser) {
    const deal = await this.prisma.deal.findUnique({
      where: { id },
      select: { id: true, created_by: true, assigned_to: true, status: true },
    });
    if (!deal) throw new NotFoundException('Không tìm thấy thương vụ');
    await assertInScope(this.scope, user, 'deals.manage', [deal.assigned_to, deal.created_by]);

    const data: Prisma.DealUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.value !== undefined) data.value = dto.value != null ? BigInt(dto.value) : null;
    if (dto.status !== undefined) {
      data.status = dto.status;
      // Chuyển sang won (từ trạng thái khác) → ghi ngày thắng; rời won → xoá. Lưu lại won (không đổi) giữ nguyên mốc cũ.
      if (dto.status === 'won' && deal.status !== 'won') data.won_at = new Date();
      else if (dto.status !== 'won') data.won_at = null;
    }
    if (dto.note !== undefined) data.note = dto.note;

    // sửa deal + outbox CÙNG transaction. Đổi `status` ⇒ `deal.stage_changed` (+ `deal.won`/`deal.lost`).
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.deal.update({ where: { id }, data, select: DEAL_SELECT });
      if (data.status !== undefined && data.status !== deal.status) {
        const opts = { resourceId: id, actorUserId: user.userId };
        const snap = snapshotDeal(row);
        await publishIntegrationEvent(
          tx,
          'deal.stage_changed',
          { deal: snap, from_status: deal.status, to_status: row.status },
          opts,
        );
        if (row.status === 'won' || row.status === 'lost') {
          await publishIntegrationEvent(tx, `deal.${row.status}`, { deal: snap }, opts);
        }
      }
      return row;
    });
    const [masked] = await this.maskDealPhone(user, [updated]);
    return { ...masked, value: masked.value !== null ? Number(masked.value) : null };
  }

  /** Mẫu B — xoá, ngoài phạm vi `deals.delete` → 404. */
  async remove(id: number, user: AuthUser) {
    const deal = await this.prisma.deal.findUnique({
      where: { id },
      select: { id: true, created_by: true, assigned_to: true },
    });
    if (!deal) throw new NotFoundException('Không tìm thấy thương vụ');
    await assertInScope(this.scope, user, 'deals.delete', [deal.assigned_to, deal.created_by]);
    await this.prisma.deal.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Mẫu D — roster cho dropdown gán thương vụ, giới hạn trong phạm vi
   * `deals.manage` của người gọi (KHÔNG còn lọc theo role literal "sales").
   */
  async searchSales(query: string, user: AuthUser) {
    if (!query || query.trim().length < 2) return [];
    const term = query.trim();
    const owner = await this.scope.ownerIds(user, 'deals.manage');
    if (Array.isArray(owner) && owner.length === 0) return [];

    const where: Prisma.UserWhereInput = {
      status: 'active',
      OR: [
        { full_name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
      ],
    };
    if (owner !== 'all') where.id = { in: owner ?? [] };

    return this.prisma.user.findMany({
      where,
      select: { id: true, full_name: true, email: true },
      take: 10,
    });
  }
}
