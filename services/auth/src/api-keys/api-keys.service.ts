import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common'
import * as crypto from 'crypto'
import { PrismaService } from '@trinity/prisma'
import { PermissionService } from '@trinity/rbac-nest'
import { can } from '@trinity/rbac'
import { CreateApiKeyDto, API_KEY_SCOPES, ApiKeyScope } from './dto/create-api-key.dto'

/** Quyền nghiệp vụ owner phải có cho từng phạm vi khoá. */
const OWNER_PERMISSION: Record<ApiKeyScope, Parameters<typeof can>[1]> = {
  'auth:login': 'contacts.create',
  'contacts:create': 'contacts.create',
  'deals:create': 'deals.manage',
  'tasks:create': 'kanban.manage',
}

// `extractPrefix` cắt theo ĐỘ DÀI prefix nên đổi KEY_PREFIX sẽ làm key đã phát hành
// bị cắt sai.
const KEY_PREFIX = 'trinity_live_'
const RANDOM_BYTES = 24 // 32 ký tự base64url ≈ 192 bit entropy

export interface ValidatedApiKey {
  id: number
  name: string
  scopes: string[]
  owner_user_id: number
}

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionService: PermissionService,
  ) {}

  /** Tạo key mới. Trả { id, prefix, plain_key } — plain_key chỉ hiển thị 1 lần. */
  async create(dto: CreateApiKeyDto, createdBy: number) {
    await this.assertOwnerUserActive(dto.owner_user_id, dto.scopes)

    const plainKey = this.generatePlainKey()
    const prefix = this.extractPrefix(plainKey)
    const keyHash = this.hashKey(plainKey)

    const record = await this.prisma.apiKey.create({
      data: {
        name: dto.name.trim(),
        prefix,
        key_hash: keyHash,
        scopes: dto.scopes,
        owner_user_id: dto.owner_user_id,
        created_by: createdBy,
        expires_at: dto.expires_at ? new Date(dto.expires_at) : null,
      },
      select: this.publicSelect(),
    })

    this.logger.log(
      `ApiKey created id=${record.id} name="${record.name}" scopes=[${dto.scopes.join(',')}] by user ${createdBy}`,
    )

    return {
      ...record,
      plain_key: plainKey,
      message:
        'Lưu lại khoá ngay — hệ thống chỉ hiển thị 1 lần duy nhất. Nếu mất, hãy xoay khoá mới.',
    }
  }

  async findAll() {
    return this.prisma.apiKey.findMany({
      select: this.publicSelect(),
      orderBy: { created_at: 'desc' },
    })
  }

  async findById(id: number) {
    const record = await this.prisma.apiKey.findUnique({
      where: { id },
      select: this.publicSelect(),
    })
    if (!record) throw new NotFoundException('Không tìm thấy khoá API')
    return record
  }

  /** Xoay khoá — giữ nguyên row, chỉ thay key_hash + prefix. */
  async rotate(id: number, rotatedBy: number) {
    const existing = await this.prisma.apiKey.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Không tìm thấy khoá API')
    if (existing.revoked_at) {
      throw new BadRequestException('Khoá đã bị thu hồi, không xoay được')
    }

    const plainKey = this.generatePlainKey()
    const prefix = this.extractPrefix(plainKey)
    const keyHash = this.hashKey(plainKey)

    const record = await this.prisma.apiKey.update({
      where: { id },
      data: { prefix, key_hash: keyHash },
      select: this.publicSelect(),
    })

    this.logger.log(`ApiKey rotated id=${id} by user ${rotatedBy}`)

    return { ...record, plain_key: plainKey }
  }

  /** Thu hồi (soft delete). Idempotent. */
  async revoke(id: number, revokedBy: number) {
    const existing = await this.prisma.apiKey.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Không tìm thấy khoá API')
    if (existing.revoked_at) {
      return { message: 'Khoá đã bị thu hồi trước đó' }
    }
    await this.prisma.apiKey.update({
      where: { id },
      data: { revoked_at: new Date() },
    })
    this.logger.log(`ApiKey revoked id=${id} by user ${revokedBy}`)
    return { message: 'Đã thu hồi khoá' }
  }

  /**
   * Xác thực header `X-API-Key` + scope. Dùng cho guard.
   * Cập nhật last_used_at/last_used_ip (fire-and-forget — không block request).
   */
  async validate(
    rawKey: string,
    requiredScope: ApiKeyScope,
    ip: string | null,
  ): Promise<ValidatedApiKey> {
    if (!rawKey || typeof rawKey !== 'string') {
      throw new UnauthorizedException('Thiếu X-API-Key header')
    }
    const hash = this.hashKey(rawKey.trim())
    const record = await this.prisma.apiKey.findUnique({
      where: { key_hash: hash },
      select: {
        id: true,
        name: true,
        scopes: true,
        owner_user_id: true,
        revoked_at: true,
        expires_at: true,
      },
    })
    if (!record) {
      throw new UnauthorizedException('X-API-Key không hợp lệ')
    }
    if (record.revoked_at) {
      throw new UnauthorizedException('Khoá API đã bị thu hồi')
    }
    if (record.expires_at && record.expires_at.getTime() < Date.now()) {
      throw new UnauthorizedException('Khoá API đã hết hạn')
    }
    if (!record.scopes.includes(requiredScope)) {
      throw new UnauthorizedException(
        `Khoá API không có phạm vi "${requiredScope}"`,
      )
    }

    this.prisma.apiKey
      .update({
        where: { id: record.id },
        data: { last_used_at: new Date(), last_used_ip: ip ?? null },
      })
      .catch((err) =>
        this.logger.warn(`ApiKey last_used update failed: ${String(err)}`),
      )

    return {
      id: record.id,
      name: record.name,
      scopes: record.scopes,
      owner_user_id: record.owner_user_id,
    }
  }

  private publicSelect() {
    return {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      owner_user_id: true,
      created_by: true,
      last_used_at: true,
      last_used_ip: true,
      expires_at: true,
      revoked_at: true,
      created_at: true,
      updated_at: true,
    } as const
  }

  private generatePlainKey(): string {
    const token = crypto.randomBytes(RANDOM_BYTES).toString('base64url')
    return `${KEY_PREFIX}${token}`
  }

  private extractPrefix(plainKey: string): string {
    return plainKey.slice(0, KEY_PREFIX.length + 6) // "trinity_live_XXXXXX"
  }

  private hashKey(plainKey: string): string {
    return crypto.createHash('sha256').update(plainKey).digest('hex')
  }

  // Whitelist owner của khoá API (least privilege): owner phải có ĐÚNG quyền nghiệp vụ mà từng scope dùng tới
  // (`auth:login`/`contacts:create` → `contacts.create`, `deals:create` → `deals.manage`, `tasks:create` → `kanban.manage`).
  // Không cho user thiếu quyền để tránh mint key dưới danh nghĩa 1 tài khoản không liên quan tới nghiệp vụ đó.
  private async assertOwnerUserActive(userId: number, scopes: readonly string[] = ['contacts:create']): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    })
    if (!user) {
      throw new BadRequestException(
        `Không tìm thấy user ID ${userId} để gán owner`,
      )
    }
    if (user.status !== 'active') {
      throw new BadRequestException(
        `User ID ${userId} đang bị khoá — không thể gán làm owner`,
      )
    }
    const { grants, isAdmin } = await this.permissionService.grantsFor(userId)
    // Quản trị KHÔNG được làm owner: JWT mint cho bên thứ 3 mang ĐÚNG quyền
    // của owner (không hạn chế thêm) — cho phép Quản trị làm owner nghĩa là
    // phát hành "khoá full-access" trá hình qua endpoint vốn chỉ dành cho
    // đăng nhập tạo contact/lead.
    if (isAdmin) {
      throw new BadRequestException(
        `User ID ${userId} là Quản trị — không được phép làm owner của API key. Chọn một tài khoản nhân viên có đúng quyền cần dùng.`,
      )
    }
    const missing = [...new Set(scopes.map((sc) => OWNER_PERMISSION[sc as ApiKeyScope]).filter(Boolean))].filter((p) => !can(grants, p))
    if (missing.length) {
      throw new BadRequestException(
        `User ID ${userId} không có quyền ${missing.map((p) => `"${p}"`).join(', ')} — không được phép làm owner của API key với các phạm vi đã chọn.`,
      )
    }
  }

  static get SCOPES(): readonly ApiKeyScope[] {
    return API_KEY_SCOPES
  }
}
