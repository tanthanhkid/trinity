import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  PrismaService,
  publishIntegrationEvent,
  snapshotContact,
  CONTACT_EVENT_SELECT,
} from '@trinity/prisma';
import type { Prisma } from '@prisma/client';
import { PublicCreateContactDto } from './dto/public-create-contact.dto';
import type { ValidatedApiKey } from './api-key.guard';
import { normalizePhone, phoneVariants } from '../google/sheet-mapping';

/**
 * Business logic cho endpoint `/public/*` — tạo contact qua API key.
 *
 * Thiết kế:
 *  - Mọi contact tạo qua API key đều được gán `assigned_to = apiKey.owner_user_id`.
 *    Owner quyết định RBAC scope (sale thấy contact của mình, team_lead thấy
 *    subtree, v.v.) — không cho bên thứ 3 chỉ định người nhận tuỳ ý.
 *  - Contact tạo qua API key inherit `team_id` từ owner (giữ RBAC consistency).
 */
@Injectable()
export class PublicApiService {
  private readonly logger = new Logger(PublicApiService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createContact(
    dto: PublicCreateContactDto,
    apiKey: ValidatedApiKey,
  ) {
    await this.validateSourceOption(dto.source_id);
    const owner = await this.loadOwner(apiKey.owner_user_id);
    // DTO nhận cả `0…` lẫn `+84…`: chuẩn hoá về 0xxxxxxxxx để check trùng không bị lọt.
    const phone = normalizePhone(dto.phone) ?? dto.phone;

    // Check duplicate bằng findFirst (bool) — KHÔNG dùng count() trên bảng lớn.
    // Bỏ qua contact đã soft-delete: chỉ cảnh báo khi có active contact cùng SDT.
    // SECURITY: chỉ check duplicate trong scope cùng owner — tránh leak
    // thông tin "SĐT đã tồn tại" cho contact thuộc owner khác.
    const existingDup = await this.prisma.contact.findFirst({
      where: { phone: { in: phoneVariants(phone) }, deleted_at: null, assigned_to: owner.id },
      select: { id: true },
    });

    // tạo khách + outbox `contact.created` CÙNG transaction (đường tạo khách của bên thứ 3 / webhook vào).
    const contact = await this.prisma.$transaction(async (tx) => {
      const created = await this.createContactInTx(
        tx,
        {
          phone,
          full_name: dto.full_name,
          source_id: dto.source_id,
          email: dto.email,
          job_title: dto.job_title,
          reminder_notes: dto.reminder_notes ?? null,
        },
        owner,
        'public_api',
      );
      // Response giữ nguyên hợp đồng cũ (không lộ thêm trường dùng cho snapshot).
      return {
        id: created.id,
        phone: created.phone,
        full_name: created.full_name,
        source_id: created.source_id,
        assigned_to: created.assigned_to,
        created_at: created.created_at,
      };
    });

    this.logger.log(
      `PublicApi contact created id=${contact.id} api_key=${apiKey.id} owner=${owner.id} had_duplicate=${existingDup !== null}`,
    );

    return {
      contact,
      warning: existingDup
        ? `SĐT đã tồn tại trong hệ thống — vẫn tạo thành công`
        : null,
    };
  }

  /**
   * LÕI tạo khách của bên thứ 3 — dùng chung cho `POST /public/contacts` (khoá API) và webhook vào:
   * gán `assigned_to = owner`, kế thừa `team_id` của owner, ghi outbox `contact.created` (origin = kênh) trong CHÍNH
   * transaction `tx` của caller. KHÔNG tự mở transaction (caller còn việc ghi cùng giao dịch: idempotency, activity).
   */
  async createContactInTx(
    tx: Prisma.TransactionClient,
    data: Omit<Prisma.ContactUncheckedCreateInput, 'assigned_to' | 'team_id'>,
    owner: { id: number; team_id: number | null },
    origin: string,
  ) {
    const created = await tx.contact.create({
      data: { ...data, assigned_to: owner.id, team_id: owner.team_id ?? null },
      select: CONTACT_EVENT_SELECT,
    });
    await publishIntegrationEvent(
      tx,
      'contact.created',
      { contact: snapshotContact(created), origin },
      { resourceId: created.id },
    );
    return created;
  }

  /** Nguồn khách đang bật (id + tên) — bên thứ 3 dùng để điền `source_id`. */
  async listSources() {
    const rows = await this.prisma.settingOption.findMany({
      where: { group_key: 'contact_source', is_active: true },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      select: { id: true, label: true },
    });
    return { data: rows.map((r) => ({ id: r.id, name: r.label })) };
  }

  private async loadOwner(userId: number) {
    const owner = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, team_id: true },
    });
    if (!owner || owner.status !== 'active') {
      throw new BadRequestException(
        `Owner user ID ${userId} của khoá API không còn hoạt động. Liên hệ quản trị viên.`,
      );
    }
    return owner;
  }

  private async validateSourceOption(id: number): Promise<void> {
    const option = await this.prisma.settingOption.findUnique({
      where: { id },
      select: { id: true, group_key: true, is_active: true },
    });
    if (!option || option.group_key !== 'contact_source') {
      throw new BadRequestException(
        `source_id ${id} không thuộc group contact_source`,
      );
    }
    if (!option.is_active) {
      throw new BadRequestException(`Nguồn khách ID ${id} đang bị tắt`);
    }
  }
}

