import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  PrismaService,
  publishIntegrationEvent,
  snapshotContact,
  snapshotDeal,
  CONTACT_EVENT_SELECT,
} from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import {
  type AuthUser,
  ScopeService,
  PermissionService,
  assertInScope,
  scopeWhere,
  makePhoneMasker,
  maskPhone,
  runInBackground,
} from '@trinity/rbac-nest';
import { REDIS_CLIENT } from '../common/redis.provider';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { QueryContactDto } from './dto/query-contact.dto';
import { deriveContactStage } from './helpers/derive-stage.helper';
import { changedContactFields } from './helpers/contact-events.helper';
import { buildScopedContactListWhere, MIN_MASKED_PHONE_SEARCH_DIGITS } from './helpers/build-contact-list-where.helper';
import { normalizePhone, phoneVariants } from '../google/sheet-mapping';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Owner của Contact — thống nhất cho MỌI quyền. */
const CONTACT_OWNER_FIELDS = ['assigned_to', 'created_by_id'] as const;

/** select cho list — bao gồm các FK SettingOption (stage, nguồn, trạng thái). */
const CONTACT_LIST_SELECT = {
  id: true,
  code: true,
  phone: true,
  phone_2: true,
  zalo_account: true,
  full_name: true,
  // avatar URL từ Zalo CDN — đồng bộ qua Zalo OA khi khách nhắn tin
  avatar_url: true,
  source_id: true,
  source_locked: true,
  stage_id: true,
  contact_status_id: true,
  assigned_to: true,
  team_id: true,
  created_by_id: true,
  created_at: true,
  // điểm lead (NULL = chưa chấm)
  lead_score: true,
  lead_label: true,
  assigned_user: { select: { full_name: true, email: true } },
  creator: { select: { id: true, full_name: true, user_roles: { select: { role: { select: { name: true } } } } } },
  team: { select: { name: true } },
  source: { select: { id: true, value: true, label: true } },
  stage: { select: { id: true, value: true, label: true } },
  contact_status: { select: { id: true, value: true, label: true } },
  deals: {
    select: {
      id: true,
      title: true,
      status: true,
      assigned_to: true,
      created_by: true,
      created_at: true,
      creator: { select: { id: true, full_name: true, email: true } },
    },
    orderBy: { created_at: 'desc' as const },
    take: 1,
  },
} as const;

/** select cho detail — thêm FK SettingOption labels + fields mở rộng. */
const CONTACT_DETAIL_SELECT = {
  id: true,
  code: true,
  phone: true,
  phone_2: true,
  zalo_account: true,
  full_name: true,
  // avatar URL từ Zalo CDN
  avatar_url: true,
  source_id: true,
  source_locked: true,
  stage_id: true,
  contact_status_id: true,
  reminder_at: true,
  reminder_notes: true,
  birthday: true,
  job_title: true,
  assigned_to: true,
  team_id: true,
  created_by_id: true,
  gender: true,
  current_address: true,
  company_name: true,
  email: true,
  custom_fields: true,
  created_at: true,
  updated_at: true,
  // điểm lead + lý do chấm
  lead_score: true,
  lead_label: true,
  lead_score_reasons: true,
  lead_scored_at: true,
  source: { select: { id: true, value: true, label: true } },
  stage: { select: { id: true, value: true, label: true } },
  contact_status: { select: { id: true, value: true, label: true } },
  creator: { select: { id: true, full_name: true, email: true, user_roles: { select: { role: { select: { name: true } } } } } },
} as const;

interface ContactDealScope {
  id?: number;
  title?: string;
  status?: string;
  assigned_to: number;
  created_by: number;
  creator?: { full_name: string | null; email: string | null } | null;
}

const VALID_SORT_FIELDS: Record<string, string> = {
  created_at: 'created_at',
  full_name: 'full_name',
  id: 'id',
  lead_score: 'lead_score',
};

/** Value mặc định của SettingOption nhóm contact_stage khi tạo contact. */
const DEFAULT_STAGE_VALUE = 'new';

/**
 * Cache count(*) cho contacts list — TTL 60s, tránh chạy COUNT trên bảng lớn
 * mỗi lần đổi page. Backend là Redis (shared cross-instance) thay cho in-memory
 * `Map` cũ — `Map` thất thoát hit rate khi PM2 cluster mở >1 worker và mỗi
 * worker có cache riêng.
 */
const COUNT_CACHE_TTL_SECONDS = 60;
const COUNT_CACHE_KEY_PREFIX = 'crm:contacts:count:';

/**
 * Skip tối đa cho page mode — chặn `OFFSET` lớn trên bảng lớn.
 * Hiện tại = 2_000 → ở `limit=50` cho phép tối đa 40 trang.
 *
 * **Tại sao giảm từ 10K xuống 2K?** OFFSET 10_000 trên bảng lớn kèm
 * `ORDER BY created_at DESC` đã đo được P95 ~1.2s (không cover bằng cursor),
 * trong khi 99% người dùng chỉ dùng <40 trang. Người cần xem dữ liệu cũ hơn phải thu
 * hẹp filter (theo team / nguồn / khoảng ngày) — đỡ tải DB đáng kể.
 */
const MAX_PAGE_OFFSET = 2_000;

/** trường Deal đủ để dựng `DealEventSnapshot` cho outbox (BigInt `value` đổi sang chuỗi ở snapshot). */
const DEAL_EVENT_SELECT = {
  id: true,
  title: true,
  description: true,
  note: true,
  value: true,
  status: true,
  assigned_to: true,
  created_by: true,
  contact_id: true,
  created_at: true,
  updated_at: true,
} as const;
type DealEventRow = Prisma.DealGetPayload<{ select: typeof DEAL_EVENT_SELECT }>;


@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly scope: ScopeService,
    private readonly permissionService: PermissionService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Build Redis key cho count cache. Hash payload bằng SHA-1 để key ngắn (40 hex
   * chars) — `JSON.stringify(where)` có thể dài vài KB khi user ràng filter
   * nhiều, vượt giới hạn key Redis (512 MB technical, nhưng best practice <1 KB).
   */
  private buildCountCacheKey(payload: {
    u: number;
    r: boolean;
    w: Prisma.ContactWhereInput;
  }): string {
    const json = JSON.stringify(payload);
    const hash = createHash('sha1').update(json).digest('hex');
    return `${COUNT_CACHE_KEY_PREFIX}${hash}`;
  }

  /**
   * Get cached count từ Redis. Trả `undefined` khi miss / lỗi — caller fallback
   * về DB count, KHÔNG crash request.
   */
  private async getCachedCount(key: string): Promise<number | undefined> {
    try {
      const raw = await this.redis.get(key);
      if (raw == null) return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis count cache get failed (${key}): ${msg}`);
      return undefined;
    }
  }

  /**
   * Best-effort set; nếu Redis lỗi chỉ log warn — count cache không phải critical
   * path (DB count vẫn chạy được).
   */
  private async setCachedCount(key: string, total: number): Promise<void> {
    try {
      await this.redis.set(key, String(total), 'EX', COUNT_CACHE_TTL_SECONDS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis count cache set failed (${key}): ${msg}`);
    }
  }

  /** `team_id` không nằm trong JWT/`AuthUser` (phạm vi chỉ
   * tính theo `manager_id`) — tra DB khi cần auto-fill field hiển thị
   * `Contact.team_id` (KHÔNG dùng cho quyết định RBAC). */
  private async resolveUserTeamId(userId: number): Promise<number | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { team_id: true },
    });
    return u?.team_id ?? null;
  }

  /**
   * Tìm option default `contact_stage` value='new'.
   * Trả về null nếu chưa seed — service sẽ để stage_id null.
   */
  private async findDefaultStageId(): Promise<number | null> {
    const opt = await this.prisma.settingOption.findUnique({
      where: {
        group_key_value: {
          group_key: 'contact_stage',
          value: DEFAULT_STAGE_VALUE,
        },
      },
      select: { id: true },
    });
    return opt?.id ?? null;
  }

  /**
   * Không lọc riêng `deals`/`activities` theo vai trò: một khi `contacts.view` cho phép xem
   * contact, caller thấy TOÀN BỘ deals/activities đính kèm — "own" là 1 định nghĩa
   * DUY NHẤT cho mọi quyền.
   */
  private filterDealsForUser<T extends ContactDealScope>(deals: T[]): T[] {
    return deals;
  }

  /**
   * Validate option FK tồn tại + thuộc đúng group + đang active.
   * Trả về `value` (mã bền) để caller tự quyết theo mã — vd xét
   * `value === 'zalo'` KHÔNG xét `label` (nhãn hiển thị có thể đổi).
   */
  private async validateOptionInGroup(
    optionId: number,
    groupKey: string,
  ): Promise<{ id: number; value: string }> {
    const opt = await this.prisma.settingOption.findUnique({
      where: { id: optionId },
      select: { id: true, group_key: true, is_active: true, value: true },
    });
    if (!opt || opt.group_key !== groupKey) {
      throw new BadRequestException(
        `Giá trị không thuộc nhóm "${groupKey}"`,
      );
    }
    if (!opt.is_active) {
      throw new BadRequestException('Giá trị đã bị vô hiệu hoá');
    }
    return { id: opt.id, value: opt.value };
  }

  /**
   * `employees.status` và `users.status` là 2 field
   * ĐỘC LẬP. Lookup sale target ở `create()` chỉ lọc
   * `users.status='active'` (nguồn chân lý cho auth-lock, đồng bộ qua
   * `syncEmployeeResignation` ở mọi đường khoá chính thức) — chặn thêm ở
   * đây để defense-in-depth cho đường KHÔNG đi qua lock chính thức (HR sửa
   * tay `employees.status` hoặc soft-delete `employees.deleted_at` mà
   * chưa/không khoá `users.status`).
   */
  private async assertAssigneeNotResigned(
    tx: Prisma.TransactionClient,
    userId: number,
  ): Promise<void> {
    const employee = await tx.employee.findUnique({
      where: { user_id: userId },
      select: { status: true, deleted_at: true },
    });
    if (employee && (employee.status === 'resigned' || employee.deleted_at !== null)) {
      throw new BadRequestException(
        'Nhân viên đã nghỉ việc, không thể gán thương vụ',
      );
    }
  }

  /**
   * Mẫu D. Trả người trong phạm vi `contacts.view` của CHÍNH
   * người gọi, dùng cho MỌI dropdown lọc nhân sự trên Danh bạ.
   */
  async listAssignableUsers(
    user: AuthUser,
  ): Promise<Array<{ id: number; full_name: string | null; email: string }>> {
    const owner = await this.scope.ownerIds(user, 'contacts.view');
    return this.prisma.user.findMany({
      where: {
        AND: [
          owner === 'all' ? {} : { id: { in: owner ?? [] } },
          { status: 'active', deleted_at: null },
        ],
      },
      select: { id: true, full_name: true, email: true },
      orderBy: { full_name: 'asc' },
      take: 200,
    });
  }

  /**
   * Danh sách contacts — RBAC + 3 filter dropdown.
   *
   * Hỗ trợ 2 mode pagination:
   *  - **page mode** (`?page=N`): trả `meta.total` + `meta.pages` cho UI page-number.
   *    Skip tối đa `MAX_PAGE_OFFSET` để tránh OFFSET lớn trên bảng lớn.
   *    Count cache 60s per (where + sort + user) — tránh repeat COUNT.
   *  - **cursor mode** (`?cursor=ID`, default): trả `meta.next_cursor` cho infinite scroll legacy.
   */
  async findAll(query: QueryContactDto, user: AuthUser) {
    const limit = query.limit ?? 50;
    const cursor = query.cursor;
    const pageMode = typeof query.page === 'number' && query.page >= 1;

    // Where-clause DÙNG CHUNG với GET /contacts/export — xem
    // `helpers/build-contact-list-where.helper.ts` cho lý do compose qua AND
    // thay vì spread trực tiếp lên scopeWhere.
    const where = await buildScopedContactListWhere(this.prisma, this.scope, user, query);

    const hasExplicitSort = Boolean(query.sort_by);
    const sortField = VALID_SORT_FIELDS[query.sort_by ?? ''] ?? 'created_at';
    const sortOrder: 'asc' | 'desc' =
      query.sort_order === 'desc' || !hasExplicitSort ? 'desc' : 'asc';
    // lead_score: khách chưa chấm (NULL) luôn xuống cuối, kể cả khi sắp tăng dần.
    const primarySort: Prisma.ContactOrderByWithRelationInput =
      sortField === 'lead_score'
        ? { lead_score: { sort: sortOrder, nulls: 'last' } }
        : { [sortField]: sortOrder };
    // Page mode: default sort dùng created_at DESC + id DESC để khớp composite
    // index `idx_contacts_assigned_to_created_at_id`. Postgres cần
    // created_at đứng đầu ORDER BY mới cover được index trên bảng lớn.
    //
    // Cursor mode: LUÔN dùng id DESC (single-field) bất kể default sort.
    // Lý do: cursor pagination dùng `cursor: { id }` (single-field Prisma cursor)
    // nếu orderBy là [created_at, id] mà nhiều contacts có cùng created_at,
    // Prisma cursor chỉ seek theo id → silent skip/duplicate trang 2+.
    // Khi user chỉ định sort_by rõ ràng (hasExplicitSort), giữ nguyên sort đó
    // vì FE đã chọn — tính ổn định cần FE dùng composite cursor (chưa support).
    const pageOrderBy: typeof primarySort[] =
      sortField !== 'id'
        ? [primarySort, { id: sortOrder }]
        : [primarySort];
    const cursorOrderBy: typeof primarySort[] = hasExplicitSort
      ? pageOrderBy
      : [{ id: 'desc' }];

    const fetchRows = (
      extra: Pick<Prisma.ContactFindManyArgs, 'skip' | 'take' | 'cursor'>,
      orderBy: typeof pageOrderBy,
    ) =>
      this.prisma.contact.findMany({
        ...extra,
        where,
        orderBy,
        select: CONTACT_LIST_SELECT,
      });

    let raw: Awaited<ReturnType<typeof fetchRows>>;
    let nextCursor: number | null = null;
    let total: number | null = null;
    let page = 1;
    let pages = 1;

    if (pageMode) {
      page = query.page!;
      const skip = (page - 1) * limit;
      if (skip + limit > MAX_PAGE_OFFSET) {
        throw new BadRequestException(
          'Vượt giới hạn phân trang. Vui lòng thu hẹp bộ lọc.',
        );
      }

      // Cache COUNT theo (user + where) — bỏ orderBy vì không ảnh hưởng count.
      // Backend Redis (TTL 60s, hash key SHA-1) — share cross-instance.
      const cacheKey = this.buildCountCacheKey({
        u: user.userId,
        r: user.isAdmin,
        w: where,
      });
      const cachedTotal = await this.getCachedCount(cacheKey);

      const [rows, freshTotal] = await Promise.all([
        fetchRows({ skip, take: limit }, pageOrderBy),
        cachedTotal !== undefined
          ? Promise.resolve(cachedTotal)
          : this.prisma.contact.count({ where }),
      ]);

      raw = rows;
      total = freshTotal;
      if (cachedTotal === undefined) {
        // Fire-and-forget — KHÔNG await để không thêm latency vào response.
        // setCachedCount tự log warn nếu Redis fail.
        void this.setCachedCount(cacheKey, freshTotal);
      }
      pages = Math.max(1, Math.ceil(total / limit));
    } else {
      const contacts = await fetchRows(
        {
          take: limit + 1,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        },
        cursorOrderBy,
      );
      const hasMore = contacts.length > limit;
      raw = hasMore ? contacts.slice(0, limit) : contacts;
      nextCursor = hasMore && raw.length > 0 ? raw[raw.length - 1].id : null;
    }

    // Mẫu C — 1 lần `ownerIds` cho cả trang, mask từng dòng bằng
    // `makePhoneMasker` (tránh N query DB, xem scope-where.ts).
    const phoneFullOwners = await this.scope.ownerIds(user, 'contacts.phone_full');
    const maskRow = makePhoneMasker(phoneFullOwners ?? []);

    const data = raw.map((c) => {
      const stage = deriveContactStage({
        stage: c.stage,
      });
      const latestDeal = this.filterDealsForUser(c.deals ?? [])[0] ?? null;
      // Chỉ hiện tên vai trò ĐẦU TIÊN của creator (thuần hiển thị, KHÔNG dùng để quyết định quyền).
      const creatorRole = c.creator?.user_roles?.[0]?.role?.name ?? null;
      const rowOwners = [c.assigned_to, c.created_by_id];
      return {
        id: c.id,
        phone: maskRow(rowOwners, c.phone),
        full_name: c.full_name,
        source: c.source,
        stage_option: c.stage,
        contact_status: c.contact_status,
        stage: stage.label,
        stage_source: stage.source,
        assigned_to: c.assigned_to,
        team_id: c.team_id,
        created_at: c.created_at,
        lead_score: c.lead_score,
        lead_label: c.lead_label,
        assignee_name: c.assigned_user?.full_name ?? null,
        assignee_email: c.assigned_user?.email ?? null,
        team_name: c.team?.name ?? null,
        creator: c.creator
          ? { id: c.creator.id, full_name: c.creator.full_name, role: creatorRole }
          : null,
        latest_deal: latestDeal
          ? {
              id: latestDeal.id,
              title: latestDeal.title,
              status: latestDeal.status,
              creator_name: latestDeal.creator?.full_name ?? null,
              creator_email: latestDeal.creator?.email ?? null,
            }
          : null,
      };
    });

    if (pageMode) {
      return {
        data,
        meta: { total: total ?? 0, page, pages, limit, next_cursor: null },
      };
    }
    return { data, meta: { next_cursor: nextCursor } };
  }

  /**
   * CRM-4 v2: Chi tiết contact — leads + activities + stage derived.
   */
  async findById(id: number, user: AuthUser) {
    // Dùng findFirst để combine `id` + `deleted_at IS NULL` — contact đã
    // soft-delete sẽ trả 404 cho mọi role kể cả super_admin (xem trash phải
    // qua endpoint riêng).
    const contact = await this.prisma.contact.findFirst({
      where: { id, deleted_at: null },
      select: {
        ...CONTACT_DETAIL_SELECT,
        assigned_user: {
          select: { id: true, full_name: true, email: true },
        },
        team: { select: { id: true, name: true } },
        deals: {
          select: {
            id: true,
            title: true,
            status: true,
            created_by: true,
            assigned_to: true,
            created_at: true,
            creator: { select: { id: true, full_name: true, email: true } },
            assignee: { select: { id: true, full_name: true, email: true } },
          },
          orderBy: { created_at: 'desc' as const },
        },
        activities: {
          select: {
            id: true,
            action: true,
            details: true,
            created_by: true,
            created_at: true,
          },
          orderBy: { created_at: 'desc' },
          take: 20,
        },
      },
    });

    if (!contact) {
      throw new NotFoundException(`Không tìm thấy contact ID ${id}`);
    }

    const ownerIds = [contact.assigned_to, contact.created_by_id];
    await assertInScope(this.scope, user, 'contacts.view', ownerIds);

    // Che SĐT theo `contacts.phone_full`.
    const phoneFullOwners = await this.scope.ownerIds(user, 'contacts.phone_full');
    const mask = makePhoneMasker(phoneFullOwners ?? []);
    const stage = deriveContactStage({ stage: contact.stage });

    return {
      ...contact,
      stage_option: contact.stage,
      phone: mask(ownerIds, contact.phone),
      phone_2: contact.phone_2 != null ? mask(ownerIds, contact.phone_2) : contact.phone_2,
      stage: stage.label,
      stage_source: stage.source,
    };
  }

  /**
   * CRM-5 v2: Tạo contact mới.
   *  - source_id bắt buộc, validate group + active.
   *  - stage_id default = option value='new'.
   *  - **CHẶN THEO SALE PHỤ TRÁCH**: SĐT
   *    trùng chỉ bị chặn (409) khi bản ghi cũ (chưa xoá) đang thuộc CHÍNH
   *    Sale sẽ phụ trách contact mới (`assignedTo` — dto.deal_assigned_to
   *    đã validate, hoặc `user.userId` khi tự tạo). SĐT trùng thuộc SALE
   *    KHÁC vẫn được tạo (mỗi Sale tự quản lý khách của mình). Trước,
   *    guard chặn CỨNG mọi trùng bất kể chủ sở hữu — nay siết
   *    đúng theo Sale.
   *    LƯU Ý: guard này CHỈ áp cho luồng tạo tay qua form (`POST /contacts`).
   */
  async create(dto: CreateContactDto, user: AuthUser) {
    await this.validateOptionInGroup(dto.source_id, 'contact_source');

    // `deal_assigned_to`: ai có `deals.manage` phủ đúng người được giao thì giao được
    // (kiểu `assertInScope`).
    if (dto.deal_assigned_to !== undefined) {
      const dealManageOwners = await this.scope.ownerIds(user, 'deals.manage');
      const inScope =
        dealManageOwners === 'all' ||
        (Array.isArray(dealManageOwners) && dealManageOwners.includes(dto.deal_assigned_to));
      if (!inScope) {
        throw new ForbiddenException(
          'Không có quyền gán thương vụ cho người được chọn (cần deals.manage phủ người này)',
        );
      }
    }

    let stageId = dto.stage_id ?? null;
    if (stageId) {
      await this.validateOptionInGroup(stageId, 'contact_stage');
    } else {
      stageId = await this.findDefaultStageId();
    }

    if (dto.contact_status_id) {
      await this.validateOptionInGroup(
        dto.contact_status_id,
        'contact_detail_status',
      );
    }

    const result = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // Khi gán thương vụ, `Contact.assigned_to` (Phụ trách) phải là người
        // đã chọn — không phải creator. Lấy thêm `team_id` để đồng bộ hiển
        // thị (KHÔNG dùng cho RBAC — scope chỉ tính theo
        // `manager_id`). Actor đã được xác nhận có `deals.manage` phủ người
        // này ở guard phía trên.
        let assignedTo: number = user.userId;
        let assignedTeamId: number | null = await this.resolveUserTeamId(user.userId);
        if (dto.deal_assigned_to !== undefined) {
          const assignee = await tx.user.findFirst({
            where: { id: dto.deal_assigned_to, status: 'active' },
            select: { id: true, team_id: true },
          });
          if (!assignee) {
            throw new BadRequestException(
              'Không tìm thấy nhân viên với ID này hoặc tài khoản không hoạt động',
            );
          }
          await this.assertAssigneeNotResigned(tx, assignee.id);
          assignedTo = assignee.id;
          assignedTeamId = assignee.team_id ?? null;
        }

        // Advisory lock theo SĐT — khép race 2 request cùng Sale gửi đồng
        // thời (contacts KHÔNG có unique constraint trên phone vì cố ý cho
        // phép khác-Sale trùng SĐT, nên chỉ dựa findFirst-rồi-create không
        // đủ an toàn). Lock tự giải phóng khi transaction kết thúc.
        // Chuẩn hoá về dạng nội địa 0xxxxxxxxx TRƯỚC khi khoá/kiểm trùng/lưu: DTO nhận cả
        // `0…` lẫn `+84…`, so chuỗi thô thì hai dạng của cùng một SĐT lọt qua check trùng.
        const phone = normalizePhone(dto.phone) ?? dto.phone;
        const phone2 = dto.phone_2 ? (normalizePhone(dto.phone_2) ?? dto.phone_2) : null;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phone}))`;

        // Chặn theo người phụ trách — findFirst + take:1 (index @@index([phone])
        // trên bảng contacts lớn), KHÔNG COUNT(*) toàn bảng.
        const duplicate = await tx.contact.findFirst({
          where: { phone: { in: phoneVariants(phone) }, deleted_at: null, assigned_to: assignedTo },
          select: { id: true, full_name: true, assigned_to: true },
          orderBy: { id: 'asc' },
        });
        if (duplicate && duplicate.assigned_to === assignedTo) {
          throw new ConflictException(
            'Khách hàng đã có trong danh sách của bạn. Vui lòng sử dụng khách hàng hiện có hoặc liên hệ quản trị viên nếu cần hỗ trợ.',
          );
        }

        const createdContact = await tx.contact.create({
          data: {
            phone,
            phone_2: phone2,
            zalo_account: dto.zalo_account ?? null,
            full_name: dto.full_name,
            source_id: dto.source_id,
            stage_id: stageId,
            contact_status_id: dto.contact_status_id ?? null,
            job_title: dto.job_title,
            birthday: dto.birthday ? new Date(dto.birthday) : null,
            reminder_at: dto.reminder_at ? new Date(dto.reminder_at) : null,
            reminder_notes: dto.reminder_notes ?? null,
            assigned_to: assignedTo,
            team_id: assignedTeamId,
            created_by_id: user.userId,
            gender: dto.gender,
            current_address: dto.current_address,
            company_name: dto.company_name,
            email: dto.email,
            // avatar URL từ Zalo CDN — chỉ set khi kênh nhắn tin truyền lên
            avatar_url: dto.avatar_url ?? null,
          },
          select: CONTACT_DETAIL_SELECT,
        });

        let createdDeal: DealEventRow | null = null;
        if (dto.deal_assigned_to !== undefined) {
          createdDeal = await tx.deal.create({
            data: {
              title: `Thương vụ từ khách hàng #${createdContact.id}`,
              assigned_to: dto.deal_assigned_to,
              created_by: user.userId,
              contact_id: createdContact.id,
            },
            select: DEAL_EVENT_SELECT,
          });
        }

        // outbox CÙNG transaction — rollback thì không có sự kiện ảo.
        await publishIntegrationEvent(
          tx,
          'contact.created',
          { contact: snapshotContact(createdContact), origin: 'manual' },
          { resourceId: createdContact.id, actorUserId: user.userId },
        );
        if (createdDeal) {
          await publishIntegrationEvent(
            tx,
            'deal.created',
            { deal: snapshotDeal(createdDeal) },
            { resourceId: createdDeal.id, actorUserId: user.userId },
          );
        }

        return { contact: createdContact, deal: createdDeal };
      },
      { maxWait: 10000, timeout: 10000 },
    );
    const { contact, deal: createdDeal } = result;

    if (createdDeal) {
      this.notificationsService
        .notifyDealAssigned({
          dealId: createdDeal.id,
          dealTitle: createdDeal.title,
          saleUserId: createdDeal.assigned_to,
          creatorName: user.email ?? `Admin #${user.userId}`,
          contactId: contact.id,
        })
        .catch((err: unknown) => {
          this.logger.error(
            `notify deal.assigned failed: deal=${createdDeal?.id} sale=${createdDeal?.assigned_to} err=${String(err)}`,
          );
        });
    }

    this.logger.log(
      `Contact created: ${maskPhone(dto.phone)} by user ${user.userId}`,
    );

    return {
      contact,
      // SĐT trùng CÙNG Sale phụ trách đã bị chặn ở trên (ConflictException).
      // Tới được đây nghĩa là SĐT chưa tồn tại HOẶC thuộc Sale khác — cả 2
      // trường hợp đều tạo thành công, `warning` luôn null. Giữ field để
      // KHÔNG phá contract response FE hiện có (kiểm tra `warning` truthy).
      warning: null,
      deal: createdDeal,
    };
  }

  /**
   * Cập nhật contact.
   * `phone` chỉ sửa được khi có `contacts.phone_full` phủ owner của contact
   * (kèm check trùng, ConflictException).
   * `full_name` BACKFILL-ONLY, nhưng admin hệ thống (`isAdmin`) được
   * phép ghi đè kể cả khi contact đã có tên (để sửa sai).
   * `source_id` BACKFILL-ONLY (service silently ignore khi đã có), trừ admin
   * hệ thống (`isAdmin`) — được đổi nguồn đã có/đã khoá để sửa sai.
   */
  async update(id: number, dto: UpdateContactDto, user: AuthUser) {
    const existing = await this.prisma.contact.findFirst({
      where: { id, deleted_at: null },
      select: {
        id: true,
        assigned_to: true,
        created_by_id: true,
        team_id: true,
        full_name: true,
        source_id: true,
        source_locked: true,
        phone: true,
        stage_id: true,
      },
    });

    if (!existing) {
      throw new NotFoundException(`Không tìm thấy contact ID ${id}`);
    }

    const ownerIds = [existing.assigned_to, existing.created_by_id];
    await assertInScope(this.scope, user, 'contacts.update', ownerIds);

    // Guard: sửa `phone` cần `contacts.phone_full` phủ ĐÚNG owner của contact
    // này (Mẫu C áp cho ghi, KHÔNG chỉ đọc) — sửa SĐT khách cần thêm
    // contacts.phone_full (không mù sửa số mình không thấy).
    if (dto.phone !== undefined) {
      const phoneFullOwners = await this.scope.ownerIds(user, 'contacts.phone_full');
      const canEditPhone =
        phoneFullOwners === 'all' ||
        (Array.isArray(phoneFullOwners) && ownerIds.some((o) => o != null && phoneFullOwners.includes(o)));
      if (!canEditPhone) {
        throw new ForbiddenException(
          'Cần quyền contacts.phone_full phủ khách hàng này để sửa số điện thoại',
        );
      }
    }

    if (dto.custom_fields !== undefined) {
      this.assertCanManageCustomFields(existing, user);
    }

    if (dto.assigned_to !== undefined || dto.team_id !== undefined) {
      await this.validateAssignmentChange(dto, user, existing.assigned_to ?? null);
    }

    if (dto.stage_id) {
      await this.validateOptionInGroup(
        dto.stage_id,
        'contact_stage',
      );
    }
    if (dto.contact_status_id) {
      await this.validateOptionInGroup(
        dto.contact_status_id,
        'contact_detail_status',
      );
    }

    // Backfill-only: full_name + source_id chỉ được ghi khi giá trị hiện tại
    // rỗng/null. Contact đã có data → silently drop để tránh override sau khi
    // tạo (vẫn giữ spirit "LOCK sau khi tạo").
    // Ngoại lệ: admin hệ thống được phép ghi đè full_name kể cả khi đã có,
    // để sửa họ tên bị nhập sai mà không cần tạo contact mới.
    // source_locked=true (Nguồn đã khoá khi tạo) → từ chối update source_id kể cả
    // khi đang null (reject rõ ràng để FE không im lặng). Admin hệ thống được
    // đổi nguồn (kể cả đã khoá) để sửa sai, cùng luật với họ tên.
    if (dto.source_id !== undefined && existing.source_locked && !user.isAdmin) {
      throw new BadRequestException(
        'Không thể sửa Nguồn: Nguồn của contact này đã khoá.',
      );
    }
    const canBackfillName =
      dto.full_name !== undefined && !existing.full_name?.trim();
    // CHỈ vai trò hệ thống "Quản trị" (`isAdmin`) được ghi đè tên đã có —
    // không có quyền catalog riêng cho "override field đã khoá".
    const canSuperAdminEditName =
      dto.full_name !== undefined && !!existing.full_name?.trim() && user.isAdmin;
    const canBackfillSource =
      dto.source_id !== undefined &&
      existing.source_id == null &&
      !existing.source_locked;
    const canSuperAdminEditSource =
      dto.source_id !== undefined &&
      dto.source_id !== existing.source_id &&
      user.isAdmin;
    if (canBackfillSource || canSuperAdminEditSource) {
      await this.validateOptionInGroup(dto.source_id!, 'contact_source');
    }

    // Phone duplicate check (chỉ khi gửi phone mới khác phone cũ).
    // Cùng luật với create(): chỉ chặn khi trùng với khách khác CÙNG người phụ trách —
    // SĐT thuộc Sale khác vẫn được phép (mỗi Sale tự quản lý khách của mình), và 409 không dò được khách của người khác.
    const newPhone = dto.phone ? (normalizePhone(dto.phone.trim()) ?? dto.phone.trim()) : dto.phone?.trim();
    const phoneChanged = newPhone !== undefined && newPhone !== existing.phone;
    // Đổi người phụ trách cũng phải kiểm trùng với danh sách của NGƯỜI NHẬN (không chỉ khi đổi SĐT).
    const assigneeChanged = dto.assigned_to != null && dto.assigned_to !== existing.assigned_to;
    const phoneToCheck = phoneChanged ? newPhone : existing.phone;
    if ((phoneChanged || assigneeChanged) && phoneToCheck) {
      const dupeCount = await this.prisma.contact.count({
        where: {
          phone: { in: phoneVariants(phoneToCheck) },
          deleted_at: null,
          id: { not: id },
          assigned_to: assigneeChanged ? dto.assigned_to! : existing.assigned_to,
        },
      });
      if (dupeCount > 0) {
        throw new ConflictException(
          `SĐT ${maskPhone(phoneToCheck)} đã có trong danh sách khách của người phụ trách này`,
        );
      }
    }

    const data = this.buildUpdateData(dto, !phoneChanged);
    if (canBackfillName || canSuperAdminEditName) {
      data.full_name = dto.full_name!.trim();
    }
    if (canBackfillSource || canSuperAdminEditSource) {
      data.source = { connect: { id: dto.source_id! } };
    }

    // update + outbox trong CÙNG transaction.
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.contact.update({
        where: { id },
        data,
        select: { ...CONTACT_DETAIL_SELECT, project_id: true, deleted_at: true },
      });
      await this.publishContactUpdateEvents(tx, row, existing, data, user.userId);
      await this.recordStageChange(tx, id, existing.stage_id, row.stage_id, user.userId);
      // project_id/deleted_at chỉ để dựng snapshot sự kiện — không đưa vào response (giữ nguyên hợp đồng API).
      const { project_id: _projectId, deleted_at: _deletedAt, ...detail } = row;
      void _projectId;
      void _deletedAt;
      return detail;
    });

    // Audit log cho phone change (audit trail)
    if (phoneChanged) {
      this.logger.log(
        `contact.phone_changed: contact=${id} old=${maskPhone(existing.phone)} new=${maskPhone(newPhone!)} by user=${user.userId}`,
      );
      runInBackground(() =>
        this.auditService.write({
          userId: user.userId,
          action: 'contact.phone_changed',
          resource: 'contacts',
          resourceId: id,
          metadata: {
            old_phone: maskPhone(existing.phone),
            new_phone: maskPhone(newPhone!),
          },
        }),
      );
    }

    // Che SĐT theo `contacts.phone_full` — cùng luật với findById/search (PATCH không được lộ số thô).
    const phoneFullOwners = await this.scope.ownerIds(user, 'contacts.phone_full');
    const mask = makePhoneMasker(phoneFullOwners ?? []);
    const rowOwners = [updated.assigned_to, updated.created_by_id];
    return {
      ...updated,
      phone: mask(rowOwners, updated.phone),
      phone_2: updated.phone_2 != null ? mask(rowOwners, updated.phone_2) : updated.phone_2,
    };
  }

  /**
   * Ghi activity `stage_change` khi giai đoạn THẬT SỰ đổi (cùng transaction với update) — dòng này là nguồn của tab
   * "Lịch sử" khách và chỉ số "đổi giai đoạn" trong bản tin (briefing-aggregator đếm `action='stage_change'`).
   * Mọi đường đổi giai đoạn (web PATCH, MCP update_contact_stage / update_record) đều đi qua `update()` nên chỉ ghi ở đây.
   */
  private async recordStageChange(
    tx: Prisma.TransactionClient,
    contactId: number,
    fromId: number | null,
    toId: number | null,
    actorUserId: number,
  ): Promise<void> {
    if (fromId === toId) return;
    const ids = [fromId, toId].filter((x): x is number => x != null);
    const opts = ids.length
      ? await tx.settingOption.findMany({ where: { id: { in: ids } }, select: { id: true, label: true } })
      : [];
    const label = (sid: number | null): string =>
      sid == null ? '(chưa có)' : (opts.find((o) => o.id === sid)?.label ?? `#${sid}`);
    const fromLabel = label(fromId);
    const toLabel = label(toId);
    await tx.activity.create({
      data: {
        contact_id: contactId,
        action: 'stage_change',
        details: {
          description: `Đổi giai đoạn: ${fromLabel} → ${toLabel}`,
          from_stage_id: fromId,
          to_stage_id: toId,
          from_label: fromLabel,
          to_label: toLabel,
        },
        metadata: {},
        created_by: actorUserId,
      },
    });
  }

  /**
   * sự kiện outbox sau khi sửa khách: `contact.updated` (luôn, nếu có trường thật sự được ghi) +
   * `contact.stage_changed` khi giai đoạn đổi + `contact.assigned` khi người phụ trách đổi.
   */
  private async publishContactUpdateEvents(
    tx: Prisma.TransactionClient,
    updated: Parameters<typeof snapshotContact>[0],
    before: { assigned_to: number | null; stage_id: number | null },
    data: Prisma.ContactUpdateInput,
    actorUserId: number,
  ): Promise<void> {
    const contact = snapshotContact(updated);
    const opts = { resourceId: updated.id, actorUserId };
    const changed = changedContactFields(data);
    if (changed.length > 0) {
      await publishIntegrationEvent(tx, 'contact.updated', { contact, changed_fields: changed }, opts);
    }
    if (before.stage_id !== contact.stage_id) {
      await publishIntegrationEvent(
        tx,
        'contact.stage_changed',
        { contact, from_stage_id: before.stage_id, to_stage_id: contact.stage_id },
        opts,
      );
    }
    if (before.assigned_to !== contact.assigned_to) {
      await publishIntegrationEvent(
        tx,
        'contact.assigned',
        { contact, from_user_id: before.assigned_to, to_user_id: contact.assigned_to },
        opts,
      );
    }
  }

  /**
   * Gom logic build UpdateInput để giữ method update < 30 lines.
   * `skipPhone=true` khi phone không thay đổi so với giá trị hiện tại —
   * tránh ghi không cần thiết xuống DB (và tránh audit log giả).
   */
  private buildUpdateData(dto: UpdateContactDto, skipPhone = false): Prisma.ContactUpdateInput {
    const data: Prisma.ContactUpdateInput = {};
    if (!skipPhone && dto.phone !== undefined) data.phone = normalizePhone(dto.phone.trim()) ?? dto.phone.trim();
    if (dto.phone_2 !== undefined) data.phone_2 = dto.phone_2 ? (normalizePhone(dto.phone_2) ?? dto.phone_2) : null;
    if (dto.zalo_account !== undefined) data.zalo_account = dto.zalo_account ?? null;
    if (dto.stage_id !== undefined) {
      data.stage = dto.stage_id
        ? { connect: { id: dto.stage_id } }
        : { disconnect: true };
    }
    if (dto.contact_status_id !== undefined) {
      data.contact_status = dto.contact_status_id
        ? { connect: { id: dto.contact_status_id } }
        : { disconnect: true };
    }
    if (dto.job_title !== undefined) data.job_title = dto.job_title;
    if (dto.reminder_notes !== undefined) {
      data.reminder_notes = dto.reminder_notes;
    }
    if (dto.reminder_at !== undefined) {
      data.reminder_at = dto.reminder_at ? new Date(dto.reminder_at) : null;
    }
    if (dto.birthday !== undefined) {
      data.birthday = dto.birthday ? new Date(dto.birthday) : null;
    }
    if (dto.gender !== undefined) data.gender = dto.gender;
    if (dto.current_address !== undefined) data.current_address = dto.current_address;
    if (dto.company_name !== undefined) data.company_name = dto.company_name;
    if (dto.email !== undefined) data.email = dto.email || null;
    if (dto.assigned_to !== undefined) {
      data.assigned_user = dto.assigned_to
        ? { connect: { id: dto.assigned_to } }
        : { disconnect: true };
    }
    if (dto.team_id !== undefined) {
      data.team = dto.team_id
        ? { connect: { id: dto.team_id } }
        : { disconnect: true };
    }
    if (dto.custom_fields !== undefined) {
      data.custom_fields = dto.custom_fields as unknown as Prisma.InputJsonValue;
    }
    return data;
  }


  /**
   * Soft-delete contact (super_admin only).
   *
   * Tại sao SOFT delete:
   * - Bảng `contacts` lớn và có nhiều FK trỏ tới → hard delete dễ throw P2003 (raw 500).
   * - Activity.contact SET NULL → hard delete làm mất link tới lịch sử KH,
   *   không khôi phục được.
   * - Audit cần giữ snapshot phone/name kể cả khi user "xoá".
   *
   * Flow (trong $transaction để audit fail rollback delete):
   *   1. Kiểm tra contact tồn tại + chưa bị xoá.
   *   2. UPDATE contacts SET deleted_at=now() WHERE id=$1.
   *   3. AuditService.writeInTx — metadata snapshot phone/name (giữ trace
   *      kể cả khi DBA hard-delete sau này).
   */
  async remove(id: number, user: AuthUser) {
    const existing = await this.prisma.contact.findUnique({
      where: { id },
      select: {
        id: true,
        phone: true,
        full_name: true,
        deleted_at: true,
        assigned_to: true,
        created_by_id: true,
      },
    });
    if (!existing || existing.deleted_at) {
      throw new NotFoundException(`Không tìm thấy contact ID ${id}`);
    }
    await assertInScope(this.scope, user, 'contacts.delete', [
      existing.assigned_to,
      existing.created_by_id,
    ]);

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.contact.update({
        where: { id },
        data: { deleted_at: new Date() },
        select: CONTACT_EVENT_SELECT,
      });
      await publishIntegrationEvent(
        tx,
        'contact.deleted',
        { contact: snapshotContact(deleted) },
        { resourceId: id, actorUserId: user.userId },
      );
      await this.auditService.writeInTx(tx, {
        userId: user.userId,
        action: 'contact.delete',
        resource: 'contacts',
        resourceId: id,
        metadata: {
          phone: existing.phone,
          full_name: existing.full_name,
        },
      });
    });

    this.logger.log(
      `Contact ID ${id} soft-deleted by user ID ${user.userId}`,
    );
    return { success: true, message: 'Đã xoá contact thành công' };
  }

  /**
   * RBAC riêng cho custom_fields: chỉ owner hoặc super_admin được chỉnh.
   * Người khác dù có quyền sửa field khác vẫn KHÔNG được đụng custom_fields của contact
   * mà họ không sở hữu.
   */
  private assertCanManageCustomFields(
    existing: { assigned_to: number | null },
    user: AuthUser,
  ): void {
    if (user.isAdmin) return;
    if (existing.assigned_to === user.userId) return;
    throw new ForbiddenException(
      'Chỉ chủ hồ sơ hoặc Quản trị được chỉnh custom field',
    );
  }

  /**
   * Kiểm tra quyền đổi `assigned_to` / `team_id`.
   *
   * Đổi `assigned_to` = một dạng CHUYỂN quyền phụ
   * trách, cần `contacts.transfer` phủ đích (mirror `ContactTransferService`,
   * cùng 1 khái niệm "transfer" nên dùng chung 1 quyền). `team_id` chỉ còn
   * là field hiển thị — validate tồn tại, không gate theo quyền riêng (base
   * `contacts.update` đã kiểm ở caller là đủ).
   */
  private async validateAssignmentChange(
    dto: UpdateContactDto,
    user: AuthUser,
    currentAssignee: number | null = null,
  ): Promise<void> {
    // Bỏ gán (assigned_to = null) cũng là chuyển quyền phụ trách: cần contacts.transfer phủ người đang phụ trách.
    if (dto.assigned_to === null && currentAssignee !== null) {
      const transferOwners = await this.scope.ownerIds(user, 'contacts.transfer');
      const inScope =
        transferOwners === 'all' ||
        (Array.isArray(transferOwners) && transferOwners.includes(currentAssignee));
      if (!inScope) {
        throw new ForbiddenException('Cần quyền contacts.transfer phủ người đang phụ trách để bỏ gán');
      }
    }
    if (dto.assigned_to != null) {
      const transferOwners = await this.scope.ownerIds(user, 'contacts.transfer');
      // Đổi sang người khác: người đang phụ trách cũng phải nằm trong phạm vi chuyển (mirror ContactTransferService).
      if (currentAssignee !== null && currentAssignee !== dto.assigned_to) {
        const currentInScope =
          transferOwners === 'all' ||
          (Array.isArray(transferOwners) && transferOwners.includes(currentAssignee));
        if (!currentInScope) {
          throw new ForbiddenException('Cần quyền contacts.transfer phủ người đang phụ trách để đổi phụ trách');
        }
      }
      const inScope =
        transferOwners === 'all' ||
        (Array.isArray(transferOwners) && transferOwners.includes(dto.assigned_to));
      if (!inScope) {
        throw new ForbiddenException(
          'Cần quyền contacts.transfer phủ người được chọn để đổi phụ trách',
        );
      }
      const target = await this.prisma.user.findUnique({
        where: { id: dto.assigned_to },
        select: { id: true, status: true, deleted_at: true },
      });
      if (!target || target.deleted_at || target.status !== 'active') {
        throw new NotFoundException(`Không tìm thấy user ID ${dto.assigned_to}`);
      }
    }

    if (dto.team_id != null) {
      const team = await this.prisma.team.findUnique({
        where: { id: dto.team_id },
        select: { id: true },
      });
      if (!team) {
        throw new NotFoundException(`Không tìm thấy team ID ${dto.team_id}`);
      }
    }
  }

  /**
   * CRM-8: tra trùng theo SĐT hoặc tên khi tạo khách — CỐ Ý không lọc
   * theo phạm vi `contacts.view` (phải thấy được khách đã tồn tại ở nhánh khác
   * để không tạo trùng), NHƯNG SĐT vẫn che theo `contacts.phone_full`.
   * Người không có `contacts.phone_full` scope `all` chỉ tra số khi gõ ≥9 chữ
   * số — tra CHỨA bằng chuỗi ngắn trên cột SĐT là oracle dò từng chữ số.
   */
  async search(term: string, user: AuthUser) {
    const trimmed = term.trim();
    if (trimmed.length < 2) return { data: [] };

    const digits = trimmed.replace(/\D/g, '');
    const isDigitsOnly = digits.length > 0 && digits === trimmed;
    const phoneFullOwners = await this.scope.ownerIds(user, 'contacts.phone_full');
    if (isDigitsOnly && phoneFullOwners !== 'all' && digits.length < MIN_MASKED_PHONE_SEARCH_DIGITS) {
      return { data: [] };
    }

    const where: Prisma.ContactWhereInput = { deleted_at: null };
    if (isDigitsOnly) {
      where.phone = { contains: digits };
    } else {
      where.full_name = { contains: trimmed, mode: 'insensitive' };
    }

    const contacts = await this.prisma.contact.findMany({
      where,
      take: 20,
      orderBy: { id: 'asc' },
      // `source_id` cho phép FE cảnh báo contact legacy thiếu nguồn trước
      // khi người dùng chọn tạo khách — chỉ là integer, không expose data nhạy cảm.
      select: {
        id: true,
        phone: true,
        full_name: true,
        source_id: true,
        assigned_to: true,
        created_by_id: true,
      },
    });

    const mask = makePhoneMasker(phoneFullOwners ?? []);
    return {
      data: contacts.map(({ assigned_to, created_by_id, ...c }) => {
        const owners = [assigned_to, created_by_id];
        return { ...c, phone: mask(owners, c.phone) };
      }),
    };
  }
}
