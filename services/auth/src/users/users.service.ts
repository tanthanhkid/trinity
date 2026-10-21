import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import { PrismaService, Prisma, recordEmploymentEnd, recordEmploymentStart } from '@trinity/prisma'
import {
  RbacCache,
  ScopeService,
  PermissionService,
  TokenBlacklistService,
  scopeWhere,
  assertInScope,
  makePhoneMasker,
  type AuthUser,
  assertUserSlotAvailable,
} from '@trinity/rbac-nest'
import { AuditLogService } from '../auth/services/audit-log.service'
import { assertCanManageUser, assertNotLastAdmin, lockAdminMutation } from '../rbac-admin/role-guardrails'
import { CreateUserDto } from './dto/create-user.dto'
import { UpdateUserDto } from './dto/update-user.dto'

interface FindAllParams {
  page: number
  limit: number
  teamId?: number
  role?: string
  roles?: string[]
  /** number = filter exact; null = filter users chưa có manager; undefined = no filter */
  managerId?: number | null
  search?: string
  status?: string
  sortBy?: 'email' | 'full_name' | 'status' | 'created_at'
  sortOrder?: 'asc' | 'desc'
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name)
  /** Max depth khi DFS chain manager_id — phòng DB dirty cycle. */
  private static readonly MAX_MANAGER_CHAIN_DEPTH = 10

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenBlacklist: TokenBlacklistService,
    private readonly auditLog: AuditLogService,
    private readonly rbacCache: RbacCache,
    private readonly scope: ScopeService,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * Chặn vòng lặp trong chain manager_id. DFS từ `newManagerId` đi ngược theo
   * manager_id; nếu gặp `userId` → throw (nghĩa là `newManagerId` nằm trong
   * SUBTREE của `userId` — gán làm manager sẽ tạo vòng lặp). Nếu vượt quá
   * MAX_MANAGER_CHAIN_DEPTH (DB đang dirty) → throw để tránh loop vô hạn.
   *
   * Thuần cấu trúc cây `manager_id` — KHÔNG phụ thuộc vai trò, áp dụng cho
   * BẤT KỲ user nào làm manager của BẤT KỲ user nào (RBAC quyền + phạm vi).
   *
   * Trường hợp `userId = null` (đang create user mới) → không thể cycle, bỏ qua.
   */
  private async assertNoManagerCycle(
    userId: number | null,
    newManagerId: number,
  ): Promise<void> {
    if (userId == null) return
    if (newManagerId === userId) {
      throw new BadRequestException(
        'Phát hiện vòng lặp trong cấu trúc quản lý',
      )
    }
    let cursor: number | null = newManagerId
    const visited = new Set<number>()
    for (let depth = 0; depth < UsersService.MAX_MANAGER_CHAIN_DEPTH; depth++) {
      if (cursor == null) return
      if (cursor === userId) {
        throw new BadRequestException(
          'Phát hiện vòng lặp trong cấu trúc quản lý',
        )
      }
      if (visited.has(cursor)) {
        throw new BadRequestException(
          'Phát hiện vòng lặp trong cấu trúc quản lý (DB dirty)',
        )
      }
      visited.add(cursor)
      const parent: { manager_id: number | null } | null =
        await this.prisma.user.findUnique({
          where: { id: cursor },
          select: { manager_id: true },
        })
      if (!parent) return
      cursor = parent.manager_id
    }
    throw new BadRequestException(
      'Chain quản lý vượt quá độ sâu cho phép (có thể có vòng lặp)',
    )
  }

  /**
   * Manager có thể là BẤT KỲ user đang active nào, không ràng buộc theo tên vai
   * trò. Chỉ có 2 ràng buộc CẤU TRÚC:
   * manager tồn tại + đang active, và không tạo vòng lặp (`assertNoManagerCycle`,
   * gọi riêng ở call-site vì nó cần `userId` của target — null khi create).
   */
  private async assertManagerActive(managerId: number): Promise<void> {
    const manager = await this.prisma.user.findUnique({
      where: { id: managerId },
      select: { status: true, deleted_at: true },
    })
    if (!manager || manager.deleted_at) {
      throw new NotFoundException('Không tìm thấy người quản lý')
    }
    if (manager.status !== 'active') {
      throw new BadRequestException('Người quản lý phải đang hoạt động (active)')
    }
  }

  async findAll(params: FindAllParams, currentUser: AuthUser) {
    const { page, limit, teamId, role, roles, search, status, sortBy, sortOrder, managerId } = params

    const skip = (page - 1) * limit

    // Owner của 1 "user" là CHÍNH nó: scopeWhere trên field `id`.
    const owner = await this.scope.ownerIds(currentUser, 'users.view')

    const filters = this.buildWhereClause(teamId, role, search, status, roles, managerId)
    const where: Prisma.UserWhereInput = {
      AND: [scopeWhere(owner ?? [], ['id']), filters, { deleted_at: null }],
    }

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        where,
        select: {
          id: true, email: true, full_name: true,
          phone: true, avatar_url: true, team_id: true, manager_id: true, status: true,
          created_at: true,
          team: { select: { name: true } },
          manager: { select: { id: true, full_name: true } },
          user_roles: { select: { role: { select: { id: true, name: true } } } },
        },
        orderBy: sortBy ? { [sortBy]: sortOrder ?? 'asc' } : { id: 'asc' },
      }),
      this.prisma.user.count({ where }),
    ])

    // `contacts.phone_full`-style: 1 lần ownerIds cho quyền xem SĐT đầy đủ,
    // mask từng dòng theo owner = chính id của dòng đó.
    const phoneAllowed = await this.scope.ownerIds(currentUser, 'users.phone_full')
    const mask = makePhoneMasker(phoneAllowed ?? [])

    return {
      data: data.map((u) => ({
        ...u,
        phone: mask([u.id], u.phone),
        roles: u.user_roles.map((ur) => ur.role.name),
        user_roles: undefined,
      })),
      total,
      page,
      limit,
    }
  }

  /**
   * Lấy TOÀN BỘ user (không phân trang) theo cùng RBAC scope + filter của
   * `findAll`, phục vụ xuất Excel danh sách người dùng. Mặc định sắp xếp theo
   * tên (A→Z) để file gọn gàng; caller có thể truyền sortBy/sortOrder khác.
   * Bảng user nhỏ → 1 query là đủ, không cần cursor.
   */
  async findAllForExport(params: FindAllParams, currentUser: AuthUser) {
    const result = await this.findAll(
      {
        ...params,
        page: 1,
        limit: 100_000,
        sortBy: params.sortBy ?? 'full_name',
        sortOrder: params.sortOrder ?? 'asc',
      },
      currentUser,
    )
    return result.data
  }

  async findById(id: number, currentUser: AuthUser) {
    await assertInScope(this.scope, currentUser, 'users.view', [id])

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, full_name: true,
        phone: true, avatar_url: true, team_id: true, manager_id: true,
        status: true, deleted_at: true,
        created_at: true, updated_at: true,
        team: { select: { name: true } },
        user_roles: { select: { role: { select: { id: true, name: true } } } },
      },
    })

    if (!user || user.deleted_at) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }

    const phoneAllowed = await this.scope.ownerIds(currentUser, 'users.phone_full')
    const mask = makePhoneMasker(phoneAllowed ?? [])

    return {
      ...user,
      phone: mask([user.id], user.phone),
      roles: user.user_roles.map((ur) => ur.role.name),
      user_roles: undefined,
    }
  }

  async create(dto: CreateUserDto, actor?: AuthUser) {
    // Email mới LUÔN chuẩn hoá lowercase (trim + toLowerCase)
    // khi ghi: đây là bản ghi HOÀN TOÀN MỚI (không có casing cũ nào cần giữ),
    // nên chuẩn hoá ngay từ lúc tạo giúp hội tụ dần về quy ước lowercase mà
    // KHÔNG cần backfill dữ liệu cũ. Collision check PHẢI case-insensitive
    // (`findFirst` + `mode:'insensitive'` — `findUnique` không diễn tả được so
    // sánh này trên field `@unique` thường) — nếu không, tạo `CAROL@...`
    // cạnh `carol@...` đã tồn tại sẽ lọt qua rồi làm login (lookup case-insensitive)
    // trở nên MƠ HỒ giữa 2 tài khoản.
    const normalizedEmail = dto.email.trim().toLowerCase()
    // Gói dịch vụ: chặn vượt max_users TRƯỚC mọi thay đổi dữ liệu.
    await assertUserSlotAvailable(this.prisma)
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      select: { id: true, deleted_at: true },
    })
    if (existing) {
      if (!existing.deleted_at) {
        throw new ConflictException('Email đã tồn tại')
      }
      // Soft-deleted user còn giữ email gốc (data cũ) — rename để giải phóng
      // unique slot cho user mới. Dùng transaction để chặn TOCTOU race.
      await this.prisma.$transaction(async (tx) => {
        const stillSoftDeleted = await tx.user.findFirst({
          where: { id: existing.id, deleted_at: { not: null } },
          select: { id: true },
        })
        if (!stillSoftDeleted) {
          throw new ConflictException('Email đã tồn tại')
        }
        await tx.user.update({
          where: { id: existing.id },
          data: { email: `deleted_${existing.id}_${Date.now()}@removed.invalid` },
        })
      })
    }

    // Validate manager_id (nếu có): manager phải tồn tại + active. Create user
    // mới → chưa có userId → không thể tạo cycle; skip assertNoManagerCycle.
    if (dto.manager_id != null) {
      await this.assertManagerActive(dto.manager_id)
    }

    const passwordHash = await bcrypt.hash(dto.password, 10)

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        full_name: dto.full_name,
        password_hash: passwordHash,
        password_updated_at: new Date(),
        team_id: dto.team_id ?? null,
        manager_id: dto.manager_id ?? null,
      },
      select: {
        id: true, email: true, full_name: true,
        team_id: true, manager_id: true, status: true,
      },
    })

    // ghi vết ai tạo tài khoản này + mật khẩu ban đầu do ai đặt.
    // Fire-and-forget best-effort — KHÔNG chặn tạo user nếu ghi audit lỗi.
    await this.auditLog.logPasswordChange({
      actorUserId: actor?.userId ?? null,
      targetUserId: user.id,
      method: 'user_create',
    })

    // mọi tài khoản CRM đồng thời LÀ 1 nhân viên — tạo hồ sơ nhân viên tối thiểu để user
    // hiển thị ngay ở Quản lý nhân viên (/management/employees) + thoả ràng buộc FK của
    // payroll/hợp đồng/KPI (employees.id/user_id). upsert idempotent: nếu đã có thì giữ nguyên.
    // status='active': HR phân loại thêm qua trang Quản lý nhân viên nếu cần.
    await this.prisma.employee.upsert({
      where: { user_id: user.id },
      create: { user_id: user.id, position: 'Chưa phân loại', status: 'active' },
      update: {},
    })

    // RBAC quyền + phạm vi — user mới có thể có manager_id (đổi
    // subtree của tổ tiên); '*' vì không biết trước ai đang có scope phủ user
    // này (rẻ, cache RAM + TTL ngắn).
    await this.rbacCache.invalidateUsers('*')

    return user
  }

  async update(id: number, dto: UpdateUserDto, actor: AuthUser) {
    if (actor.userId === id) {
      throw new ForbiddenException('Không thể tự thay đổi thông tin tài khoản của mình')
    }

    // Target ngoài scope `users.manage` → 404; quyền hiện có của target không
    // ⊆ quyền actor → 403 (escalation so theo QUYỀN, không theo tên vai trò).
    await assertCanManageUser(this.scope, this.permissionService, actor, id)

    const user = await this.prisma.user.findUnique({ where: { id } })
    if (!user || user.deleted_at) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }

    // chỉ TRIM khi so sánh/ghi (KHÔNG ép lowercase như
    // create()): update() có thể chạm vào tài khoản cũ đang mang email
    // viết hoa sẵn — nếu ép lowercase vô điều kiện, MỘT PATCH không liên quan
    // (vd chỉ đổi SĐT) mà FE gửi kèm nguyên field email hiện tại sẽ âm thầm
    // đổi casing của họ. Ghi giá trị MỚI CHỈ khi admin THẬT SỰ đổi identity
    // (so sánh case-insensitive dưới đây) — giữ nguyên casing hiện có ở mọi
    // trường hợp khác, kể cả khi admin chủ động sửa lại casing của CHÍNH
    // email hiện tại (nhánh đó KHÔNG đi qua collision-check bên dưới, vì điều
    // kiện `!==` ở đây đã loại trừ nó — identity không đổi thì không có gì
    // cần kiểm tra).
    const normalizedEmail = dto.email?.trim()
    if (normalizedEmail && normalizedEmail.toLowerCase() !== user.email.toLowerCase()) {
      // Case-insensitive lookup — `findUnique` không diễn tả
      // được so sánh không phân biệt hoa/thường trên field `@unique` thường.
      // `NOT: { id }` là lớp phòng thủ THỨ 2 (defense-in-depth): điều kiện
      // `!==` ở trên đã đảm bảo giá trị mới KHÁC email hiện tại của CHÍNH
      // user này (kể cả không phân biệt hoa/thường) nên về lý thuyết `existing`
      // không thể trỏ về chính bản ghi này — loại trừ tường minh để không phụ
      // thuộc ngầm vào bất biến đó nếu logic phía trên thay đổi sau này.
      const existing = await this.prisma.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' }, NOT: { id } },
        select: { id: true, deleted_at: true },
      })
      if (existing) {
        if (!existing.deleted_at) {
          throw new ConflictException('Email đã tồn tại')
        }
        // Soft-deleted user còn giữ email gốc — rename trong transaction
        // để chặn TOCTOU race với request khác cùng claim email này.
        await this.prisma.$transaction(async (tx) => {
          const stillSoftDeleted = await tx.user.findFirst({
            where: { id: existing.id, deleted_at: { not: null } },
            select: { id: true },
          })
          if (!stillSoftDeleted) {
            throw new ConflictException('Email đã tồn tại')
          }
          await tx.user.update({
            where: { id: existing.id },
            data: { email: `deleted_${existing.id}_${Date.now()}@removed.invalid` },
          })
        })
      }
    }

    // Validate manager_id nếu caller truyền vào (kể cả null để clear).
    if (dto.manager_id !== undefined && dto.manager_id !== null) {
      await this.assertManagerActive(dto.manager_id)
      // Chặn vòng lặp: DFS từ newManagerId đi theo manager_id chain.
      await this.assertNoManagerCycle(id, dto.manager_id)
    }

    // Cascade reassign managed_users khi status chuyển sang 'locked'.
    // Đồng bộ với Delete endpoint: PATCH /users/:id {status:"locked", reassign_to:N}
    // phải có cùng hiệu ứng với DELETE /users/:id {reassign_to:N}.
    // Khoá KHÔNG đổi email: mở khoá lại dùng được ngay. Chỉ "xoá vĩnh viễn" mới giải phóng email.
    const isLocking = dto.status === 'locked' && user.status !== 'locked'
    // Gói dịch vụ: mở khoá (locked → active) cũng chiếm một chỗ trong max_users.
    if (dto.status === 'active' && user.status !== 'active') {
      await assertUserSlotAvailable(this.prisma)
    }
    let cascadeReassigned = 0
    if (isLocking) {
      // Quản trị cuối cùng (409) — cùng luật với DELETE /users/:id.
      await assertNotLastAdmin(this.prisma, id)
      const managedCount = await this.prisma.user.count({
        where: { manager_id: id },
      })
      // Việc chuyển giao cấp dưới nằm TRONG transaction bên dưới (sau kiểm tra quản trị cuối cùng).
      cascadeReassigned = managedCount
    }

    // user.update + đồng bộ employees PHẢI cùng transaction — nếu
    // employee.updateMany fail SAU KHI user đã lock/unlock thành công mà không có tx,
    // sẽ để lại trạng thái lệch (users.status đã đổi nhưng employees chưa đồng bộ).
    const updated = await this.prisma.$transaction(async (tx) => {
      if (isLocking) {
        // Kiểm lại DƯỚI khoá advisory — chống 2 Quản trị bị khoá song song.
        await lockAdminMutation(tx)
        await assertNotLastAdmin(tx, id)
        if (cascadeReassigned > 0) {
          await this.cascadeReassignManagedUsersTx(tx, id, cascadeReassigned, dto.reassign_to)
        }
      }
      const u = await tx.user.update({
        where: { id },
        data: {
          email: normalizedEmail,
          full_name: dto.full_name,
          phone: dto.phone,
          team_id: dto.team_id,
          manager_id: dto.manager_id,
          status: dto.status,
          // Khoá thu hồi mọi refresh token cũ — mở khoá lại không làm chúng sống lại.
          ...(isLocking ? { tokens_valid_after: new Date() } : {}),
        },
        select: {
          id: true, email: true, full_name: true, phone: true,
          team_id: true, manager_id: true, status: true,
        },
      })

      // Khoá tài khoản = nghỉ việc → đồng bộ employees.status + resigned_at
      // (nguồn chuẩn nghỉ việc). Mở khoá lại (→active) xoá mốc ngày nghỉ.
      if (isLocking) {
        await this.syncEmployeeResignation(id, true, tx)
      } else if (dto.status === 'active' && user.status === 'locked') {
        await this.syncEmployeeResignation(id, false, tx)
      }

      return u
    })

    if (dto.status === 'locked') {
      this.tokenBlacklist.blacklistUser(id)
    }

    if (isLocking) {
      this.logger.warn('[user-lock]', {
        actor_user_id: actor.userId,
        target_user_id: id,
        target_email: maskEmail(user.email),
        reassign_to: dto.reassign_to ?? null,
        managed_users_count: cascadeReassigned,
        timestamp: new Date().toISOString(),
      })
    }

    // RBAC quyền + phạm vi — manager_id/khoá tài khoản đều có thể
    // đổi ở nhánh trên; invalidate vô điều kiện đơn giản + an toàn hơn dò từng
    // nhánh (đổi cây quản lý ảnh hưởng TỔ TIÊN, không chỉ chính user).
    await this.rbacCache.invalidateUsers('*')

    // Che SĐT như findAll/findById — PATCH không được lộ số thô cho người thiếu `users.phone_full`.
    const phoneAllowed = await this.scope.ownerIds(actor, 'users.phone_full')
    const mask = makePhoneMasker(phoneAllowed ?? [])

    return {
      ...updated,
      phone: mask([updated.id], updated.phone),
      ...(cascadeReassigned > 0
        ? {
            reassigned: cascadeReassigned,
            reassigned_to: dto.reassign_to ?? null,
          }
        : {}),
    }
  }

  async resetPassword(id: number, customPassword: string | undefined, actor: AuthUser) {
    if (actor.userId === id) {
      throw new ForbiddenException('Không thể tự reset mật khẩu của chính mình qua endpoint này')
    }

    // escalation THẬT SỰ chạy TRƯỚC check password bắt buộc bên
    // dưới: actor không có quyền phải nhận đúng 403, KHÔNG lộ nhầm 400 trước
    // (mirror hành vi cũ — xem `reset-password.dto.ts`).
    await assertCanManageUser(this.scope, this.permissionService, actor, id)

    const user = await this.prisma.user.findUnique({ where: { id } })
    if (!user || user.deleted_at) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }

    // Không sinh và trả mật khẩu plaintext trong response JSON: BẮT BUỘC admin tự nhập — đây là ĐIỂM ENFORCE
    // THẬT (không phải defense-in-depth): DTO CỐ Ý dùng @IsOptional() (KHÔNG
    // @IsNotEmpty) để request thiếu password vẫn qua được ValidationPipe và tới được
    // đây, cho escalation guard PHÍA TRÊN kịp chạy trước — nếu DTO chặn ở Pipe,
    // actor không có quyền + bỏ trống password sẽ nhận nhầm 400 thay vì 403 (Guards
    // chạy trước Pipes trong NestJS lifecycle, escalation guard nằm ở service tức
    // sau Pipes). Xem chi tiết ở `reset-password.dto.ts`.
    if (!customPassword?.trim()) {
      throw new BadRequestException('Vui lòng nhập mật khẩu mới')
    }
    const newPassword = customPassword
    const passwordHash = await bcrypt.hash(newPassword, 10)

    await this.prisma.user.update({
      where: { id },
      data: { password_hash: passwordHash, password_updated_at: new Date(), tokens_valid_after: new Date() },
    })

    this.tokenBlacklist.blacklistUser(id)

    this.logger.warn('[user-reset-password]', {
      actor_user_id: actor.userId,
      target_user_id: id,
      target_email: maskEmail(user.email),
      custom_password_provided: customPassword !== undefined,
      timestamp: new Date().toISOString(),
    })

    // Ghi audit_logs (truy vấn được bằng SQL), không chỉ logger.warn.
    await this.auditLog.logPasswordChange({
      actorUserId: actor.userId,
      targetUserId: id,
      method: 'admin_reset',
    })

    // KHÔNG trả `password` trong response — plaintext không được đi qua network.
    // Admin đã tự gõ mật khẩu này ở FE nên đã biết giá trị, không cần echo lại.
    return { message: 'Đã reset mật khẩu thành công' }
  }

  /**
   * tra cứu lịch sử đổi/reset mật khẩu của 1 user — đọc `audit_logs`
   * (action='password_change', resource='users', resource_id=id). KHÔNG BAO GIỜ
   * trả giá trị mật khẩu/hash — chỉ ai/khi nào/qua đường nào.
   */
  async getPasswordHistory(id: number, actor: AuthUser) {
    await assertInScope(this.scope, actor, 'users.manage', [id])

    const logs = await this.prisma.auditLog.findMany({
      where: { action: 'password_change', resource: 'users', resource_id: id },
      orderBy: { created_at: 'desc' },
      take: 50,
      select: { id: true, user_id: true, metadata: true, ip_address: true, created_at: true },
    })

    const actorIds = Array.from(
      new Set(logs.map((l) => l.user_id).filter((v): v is number => v != null)),
    )
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true, full_name: true },
        })
      : []
    const actorMap = new Map(actors.map((a) => [a.id, a]))

    return logs.map((log) => {
      const meta = (log.metadata ?? {}) as { method?: string }
      const logActor = log.user_id != null ? actorMap.get(log.user_id) : undefined
      return {
        id: log.id,
        created_at: log.created_at,
        method: meta.method ?? null,
        actor_id: log.user_id,
        actor_email: logActor?.email ?? null,
        actor_full_name: logActor?.full_name ?? null,
        ip_address: log.ip_address,
      }
    })
  }

  /**
   * Soft-lock user. Nếu user đang là manager của ≥1 users:
   * - reassignTo có giá trị → update managed_users.manager_id = reassignTo.
   *   reassignTo phải tồn tại, phải khác self, và không tạo cycle.
   * - reassignTo = undefined | null → set null + log warning (orphan).
   */
  async delete(id: number, reassignTo: number | null | undefined, actor: AuthUser) {
    if (actor.userId === id) {
      throw new ForbiddenException('Không thể tự khoá tài khoản của mình')
    }
    await assertCanManageUser(this.scope, this.permissionService, actor, id)

    const user = await this.prisma.user.findUnique({ where: { id } })
    if (!user || user.deleted_at) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }
    // Quản trị cuối cùng (409): khoá = mất đăng nhập, cả hệ thống hết người quản trị.
    await assertNotLastAdmin(this.prisma, id)

    const managedCount = await this.prisma.user.count({
      where: { manager_id: id, deleted_at: null },
    })

    // cùng transaction với sync employees — tránh lệch trạng thái nếu
    // employee.updateMany fail sau khi user đã bị khoá.
    await this.prisma.$transaction(async (tx) => {
      await lockAdminMutation(tx)
      await assertNotLastAdmin(tx, id)
      // Chuyển giao cấp dưới cùng transaction: 409 hoặc lỗi đồng bộ nhân viên sẽ hoàn tác cả việc chuyển giao.
      if (managedCount > 0) {
        await this.cascadeReassignManagedUsersTx(tx, id, managedCount, reassignTo)
      }
      await tx.user.update({
        where: { id },
        data: {
          status: 'locked',
          tokens_valid_after: new Date(),
        },
      })

      // Khoá = nghỉ việc → đồng bộ employees.status='resigned' + resigned_at.
      await this.syncEmployeeResignation(id, true, tx)
    })

    this.tokenBlacklist.blacklistUser(id)
    // RBAC quyền + phạm vi — khoá user + cascade reassign
    // managed_users đổi cây quản lý.
    await this.rbacCache.invalidateUsers('*')
    return {
      message: 'Đã khoá tài khoản',
      reassigned: managedCount,
      reassigned_to: reassignTo ?? null,
    }
  }

  /**
   * đồng bộ trạng thái nghỉ việc sang bảng `employees` (nguồn chuẩn cho
   * Quản lý hợp đồng + Chấm công). `users.status='locked'` = đã nghỉ việc → set
   * `employees.status='resigned'` + `resigned_at` (mốc ngày loại khỏi chấm công);
   * mở khoá lại → khôi phục `active` + xoá mốc. User chưa có employee ⇒ không làm gì.
   * Đồng thời đóng / mở giai đoạn làm việc (`employment_periods`) để chấm công cũ giữ nguyên khoảng bị khoá.
   * Khoá lại người ĐÃ nghỉ không dời ngày nghỉ sang hôm nay.
   */
  private async syncEmployeeResignation(
    userId: number,
    resigned: boolean,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const employee = await tx.employee.findUnique({ where: { user_id: userId }, select: { id: true } })
    if (!employee) return
    if (resigned) {
      await recordEmploymentEnd(tx, employee.id)
      await tx.employee.updateMany({
        where: { id: employee.id, status: { not: 'resigned' } },
        data: { status: 'resigned', resigned_at: new Date() },
      })
    } else {
      await recordEmploymentStart(tx, employee.id)
      await tx.employee.update({ where: { id: employee.id }, data: { status: 'active', resigned_at: null } })
    }
  }

  /**
   * Xoá vĩnh viễn (soft delete sâu hơn `delete()`): chỉ ai có `users.manage`
   * scope phủ target + quyền của target ⊆ quyền actor (`assertCanManageUser`).
   * Set `deleted_at = now()` + `status = 'locked'`. User biến mất khỏi mọi
   * UI quản trị (findAll/findById đều filter
   * `deleted_at: null`). KHÔNG hard delete để giữ FK references
   * (contacts, deals, tasks, audit logs...).
   *
   * Cascade reassign managed_users tương tự `delete()` để không bỏ orphan
   * subordinates không có manager.
   *
   * Atomicity: cascade reassign + final update gói trong $transaction để
   * tránh orphan state khi step sau fail (vd: managed_users đã bị reassign
   * nhưng target user chưa kịp set deleted_at).
   *
   * Guards bổ sung:
   * - Self-delete: defense in depth, controller cũng đã chặn.
   * - Quản trị cuối cùng: không cho xoá Quản trị cuối cùng (lock-out cả hệ thống).
   */
  async softDeletePermanent(
    id: number,
    reassignTo: number | null | undefined,
    actor: AuthUser,
  ) {
    if (actor.userId === id) {
      throw new ForbiddenException(
        'Không thể tự xoá vĩnh viễn tài khoản của mình',
      )
    }
    await assertCanManageUser(this.scope, this.permissionService, actor, id)

    const result = await this.prisma.$transaction(async (tx) => {
      // Re-fetch trong tx để chống race (user vừa bị xoá ở request khác).
      const target = await tx.user.findUnique({
        where: { id },
        include: { user_roles: { include: { role: true } } },
      })
      if (!target || target.deleted_at) {
        throw new NotFoundException('Không tìm thấy người dùng')
      }

      // Quản trị cuối cùng (409): không cho xoá người cuối cùng giữ vai trò hệ thống.
      await lockAdminMutation(tx)
      await assertNotLastAdmin(tx, id)

      const managedCount = await tx.user.count({
        where: { manager_id: id, deleted_at: null },
      })

      if (managedCount > 0) {
        await this.cascadeReassignManagedUsersTx(
          tx,
          id,
          managedCount,
          reassignTo,
        )
      }

      await tx.user.update({
        where: { id },
        data: {
          status: 'locked',
          deleted_at: new Date(),
          tokens_valid_after: new Date(),
          // Xoá vĩnh viễn (khác khoá) giải phóng email để tạo lại user cùng email.
          email: `deleted_${id}_${Date.now()}@removed.invalid`,
        },
      })

      // xoá vĩnh viễn = nghỉ việc → đồng bộ employees.status + resigned_at + giai đoạn làm việc (trong tx).
      await this.syncEmployeeResignation(id, true, tx)

      return { managedCount, targetEmail: target.email }
    })

    // Side effects ngoài tx (idempotent / không cần atomic).
    this.tokenBlacklist.blacklistUser(id)
    this.logger.warn('[user-soft-delete-permanent]', {
      actor_user_id: actor.userId,
      target_user_id: id,
      target_email: maskEmail(result.targetEmail),
      reassign_to: reassignTo ?? null,
      managed_users_count: result.managedCount,
      timestamp: new Date().toISOString(),
    })

    // RBAC quyền + phạm vi — xoá vĩnh viễn + cascade reassign
    // managed_users đổi cây quản lý.
    await this.rbacCache.invalidateUsers('*')

    return {
      message: 'Đã xoá vĩnh viễn tài khoản',
      reassigned: result.managedCount,
      reassigned_to: reassignTo ?? null,
    }
  }

  /**
   * Version nhận tx client (Prisma transaction) hoặc PrismaService — cho
   * `softDeletePermanent` dùng atomic. Logic giống hệt
   * `cascadeReassignManagedUsers` nhưng chạy bên trong tx.
   */
  private async cascadeReassignManagedUsersTx(
    tx: Prisma.TransactionClient | PrismaService,
    lockedUserId: number,
    managedCount: number,
    reassignTo: number | null | undefined,
  ): Promise<void> {
    if (reassignTo != null) {
      if (reassignTo === lockedUserId) {
        throw new BadRequestException(
          'Không thể chuyển giao cho chính user đang bị khoá',
        )
      }
      const newManager = await tx.user.findUnique({
        where: { id: reassignTo },
        select: { id: true, status: true, deleted_at: true, manager_id: true },
      })
      if (!newManager || newManager.deleted_at) {
        throw new NotFoundException('Người quản lý mới không tồn tại')
      }
      if (newManager.status !== 'active') {
        throw new BadRequestException(
          'Người quản lý mới phải đang active',
        )
      }
      // reassign_to có thể là cấp dưới của user bị khoá ở BẤT KỲ độ sâu nào (không chỉ trực
      // tiếp): chuyển các cấp dưới trực tiếp sang nó sẽ tạo vòng manager_id. Đi ngược chuỗi
      // quản lý của nó; nếu gặp user bị khoá thì nâng nó lên cấp trên của user bị khoá.
      let isDescendant = false
      let cursor: number | null = newManager.manager_id
      const seen = new Set<number>([reassignTo])
      while (cursor != null && !seen.has(cursor)) {
        if (cursor === lockedUserId) {
          isDescendant = true
          break
        }
        seen.add(cursor)
        const parent: { manager_id: number | null } | null =
          await tx.user.findUnique({
            where: { id: cursor },
            select: { manager_id: true },
          })
        cursor = parent?.manager_id ?? null
      }
      if (isDescendant) {
        const locked = await tx.user.findUnique({
          where: { id: lockedUserId },
          select: { manager_id: true },
        })
        await tx.user.update({
          where: { id: reassignTo },
          data: { manager_id: locked?.manager_id ?? null },
        })
      }
      await tx.user.updateMany({
        where: { manager_id: lockedUserId, id: { not: reassignTo } },
        data: { manager_id: reassignTo },
      })
      this.logger.log(
        `Locked user #${lockedUserId}: reassigned ${managedCount} managed_users -> manager #${reassignTo}`,
      )
      return
    }
    // Orphan path: set null + log warning
    await tx.user.updateMany({
      where: { manager_id: lockedUserId },
      data: { manager_id: null },
    })
    this.logger.warn(
      `Locked user #${lockedUserId}: ${managedCount} managed_users orphaned (manager_id=null). Caller did not supply reassign_to.`,
    )
  }

  async assignTeam(userId: number, teamId: number, actor: AuthUser) {
    await assertCanManageUser(this.scope, this.permissionService, actor, userId)

    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }

    const team = await this.prisma.team.findUnique({ where: { id: teamId } })
    if (!team) {
      throw new NotFoundException('Không tìm thấy team')
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { team_id: teamId },
      select: { id: true, email: true, full_name: true, team_id: true },
    })

    this.tokenBlacklist.blacklistUser(userId)
    return updated
  }

  private buildWhereClause(
    teamId?: number,
    role?: string,
    search?: string,
    status?: string,
    roles?: string[],
    managerId?: number | null,
  ) {
    const where: Prisma.UserWhereInput = {}
    if (teamId) where.team_id = teamId
    if (managerId === null) where.manager_id = null
    else if (managerId) where.manager_id = managerId
    if (status) where.status = status
    if (search) {
      where.OR = [
        { full_name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ]
    }
    if (roles && roles.length > 0) {
      where.user_roles = { some: { role: { name: { in: roles } } } }
    } else if (role) {
      where.user_roles = { some: { role: { name: role } } }
    }
    return where
  }
}

/**
 * Mask email để không leak PII vào audit log / ELK.
 * "abc@domain.com" → "a***@domain.com"
 * Tuân thủ security.md: không log email plaintext.
 */
function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return '***'
  const [local, domain] = email.split('@')
  if (local.length <= 1) return `*@${domain}`
  return `${local[0]}***@${domain}`
}
