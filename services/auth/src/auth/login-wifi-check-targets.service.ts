import { BadRequestException, Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { LoginWifiCheckTargetItemDto } from './dto/login-wifi-check-targets.dto'
import { LoginWifiCheckScopeType } from './login-wifi-check-targets.helper'

export interface LoginWifiCheckTargetView {
  id: number
  scope_type: LoginWifiCheckScopeType
  target_user_id: number
  target_name: string | null
  target_email: string | null
  target_active: boolean
}

export interface LoginWifiCheckRosterUser {
  id: number
  full_name: string | null
  email: string
  roles: string[]
  manager_id: number | null
}

/**
 * CRUD cấu hình "danh sách áp dụng" cho login-wifi-check. CHỈ
 * dùng bởi `LoginWifiCheckTargetsController` (quyền settings.integrations) — KHÔNG inject vào
 * `AuthService` (login path dùng hàm thuần `resolveLoginWifiTargetedForUser`
 * ở `login-wifi-check-targets.helper.ts` để tránh đổi DI của AuthService).
 */
@Injectable()
export class LoginWifiCheckTargetsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Roster active để render 3 picker Phòng/Team/Nhân viên — bounded (dưới cap
   * `limit<=1000` của `GET /users`). Dùng query RIÊNG (KHÔNG tái dùng `UsersService.findAll`)
   * để không phụ thuộc vào các nhánh RBAC force-filter đa mục đích của
   * `/users` (theo vai trò, chỉ xem bản thân...) — endpoint này CHỈ phục
   * vụ quản trị Cài đặt nên chỉ cần đúng 1 điều kiện `deleted_at: null`, tách biệt
   * khỏi mọi thay đổi tương lai ở `/users` không liên quan tính năng này. */
  async getRoster(): Promise<LoginWifiCheckRosterUser[]> {
    const users = await this.prisma.user.findMany({
      where: { deleted_at: null },
      select: {
        id: true,
        full_name: true,
        email: true,
        manager_id: true,
        user_roles: { select: { role: { select: { name: true } } } },
      },
      orderBy: { full_name: 'asc' },
    })
    return users.map((u) => ({
      id: u.id,
      full_name: u.full_name,
      email: u.email,
      roles: u.user_roles.map((ur) => ur.role.name),
      manager_id: u.manager_id,
    }))
  }

  /** Danh sách RAW đang cấu hình, kèm tên/email để hiển thị FE. */
  async list(): Promise<LoginWifiCheckTargetView[]> {
    const rows = await this.prisma.loginWifiCheckTarget.findMany({
      orderBy: { id: 'asc' },
    })
    if (rows.length === 0) return []

    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.target_user_id) } },
      select: { id: true, full_name: true, email: true, deleted_at: true, status: true },
    })
    const byId = new Map(users.map((u) => [u.id, u]))

    return rows.map((r) => {
      const u = byId.get(r.target_user_id)
      return {
        id: r.id,
        scope_type: r.scope_type as LoginWifiCheckScopeType,
        target_user_id: r.target_user_id,
        target_name: u?.full_name ?? null,
        target_email: u?.email ?? null,
        target_active: !!u && u.deleted_at === null && u.status === 'active',
      }
    })
  }

  /** Thay TOÀN BỘ danh sách áp dụng. Mảng rỗng = xoá sạch (xem JSDoc ngữ
   * nghĩa "rỗng = không ai bị áp dụng" ở `login-wifi-check-targets.helper.ts`). */
  async replaceAll(
    items: LoginWifiCheckTargetItemDto[],
    actorId: number,
  ): Promise<LoginWifiCheckTargetView[]> {
    const deduped = this.dedupe(items)
    await this.assertValidTargets(deduped)

    await this.prisma.$transaction(async (tx) => {
      await tx.loginWifiCheckTarget.deleteMany({})
      if (deduped.length > 0) {
        await tx.loginWifiCheckTarget.createMany({
          data: deduped.map((i) => ({
            scope_type: i.scope_type,
            target_user_id: i.target_user_id,
            created_by: actorId,
          })),
        })
      }
    })

    return this.list()
  }

  private dedupe(items: LoginWifiCheckTargetItemDto[]): LoginWifiCheckTargetItemDto[] {
    const seen = new Set<string>()
    const result: LoginWifiCheckTargetItemDto[] = []
    for (const item of items) {
      const key = `${item.scope_type}:${item.target_user_id}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(item)
    }
    return result
  }

  /**
   * "Phòng"/"Team" được định nghĩa THUẦN CẤU TRÚC theo cây `manager_id`
   * (không phụ thuộc tên vai trò):
   * - `team` → target phải đang quản lý ÍT NHẤT 1 người (có `managed_users`).
   * - `department` → target phải có ÍT NHẤT 1 cấp dưới MÀ cấp dưới đó cũng
   *   đang quản lý người khác (subtree ≥2 cấp).
   * - `user` → target phải là user active bất kỳ.
   * Ngăn cấu hình trỏ vào id đã xoá/không đúng cấu trúc.
   */
  private async assertValidTargets(items: LoginWifiCheckTargetItemDto[]): Promise<void> {
    const teamIds = items.filter((i) => i.scope_type === 'team').map((i) => i.target_user_id)
    if (teamIds.length > 0) {
      const valid = await this.prisma.user.findMany({
        where: {
          id: { in: teamIds },
          deleted_at: null,
          status: 'active',
          managed_users: { some: {} },
        },
        select: { id: true },
      })
      if (valid.length !== new Set(teamIds).size) {
        throw new BadRequestException(
          'Có Team không hợp lệ (đã xoá/khoá/không đang quản lý ai) trong danh sách',
        )
      }
    }

    const deptIds = items.filter((i) => i.scope_type === 'department').map((i) => i.target_user_id)
    if (deptIds.length > 0) {
      const valid = await this.prisma.user.findMany({
        where: {
          id: { in: deptIds },
          deleted_at: null,
          status: 'active',
          managed_users: { some: { managed_users: { some: {} } } },
        },
        select: { id: true },
      })
      if (valid.length !== new Set(deptIds).size) {
        throw new BadRequestException(
          'Có Phòng không hợp lệ (đã xoá/khoá/không quản lý cấp trung gian) trong danh sách',
        )
      }
    }

    const userIds = items.filter((i) => i.scope_type === 'user').map((i) => i.target_user_id)
    if (userIds.length > 0) {
      const valid = await this.prisma.user.findMany({
        where: { id: { in: userIds }, deleted_at: null, status: 'active' },
        select: { id: true },
      })
      if (valid.length !== new Set(userIds).size) {
        throw new BadRequestException('Có nhân viên không hợp lệ (đã xoá/khoá) trong danh sách')
      }
    }
  }
}
