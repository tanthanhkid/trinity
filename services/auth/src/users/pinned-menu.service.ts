import { Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { CUSTOM_MENU_KEY_PREFIX, parseCustomMenuKey } from './pinned-menu.constants'

export interface PinnedMenuResponse {
  keys: string[]
}

/**
 * Ghim menu sidebar theo user — preference cá nhân thuần, tách
 * khỏi `UsersService` (vốn đã lớn) để module này gọn và dễ soi riêng.
 */
@Injectable()
export class PinnedMenuService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: number): Promise<PinnedMenuResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pinned_menu_keys: true },
    })
    return { keys: await this.dropStaleCustomKeys(user?.pinned_menu_keys ?? []) }
  }

  async update(userId: number, keys: string[]): Promise<PinnedMenuResponse> {
    const deduped = await this.dropStaleCustomKeys(Array.from(new Set(keys)))
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { pinned_menu_keys: deduped },
      select: { pinned_menu_keys: true },
    })
    return { keys: updated.pinned_menu_keys }
  }

  /**
   * Key bảng tuỳ biến mà bảng (hoặc màn xem) không còn tồn tại / đã lưu trữ thì bỏ đi — vừa không lưu
   * khoá ma, vừa không làm FE (gửi lại cả danh sách) bị 400 vì một ghim cũ. Key cố định giữ nguyên.
   */
  private async dropStaleCustomKeys(keys: string[]): Promise<string[]> {
    const targets = new Map(
      keys.filter((k) => k.startsWith(CUSTOM_MENU_KEY_PREFIX)).map((k) => [k, parseCustomMenuKey(k)] as const),
    )
    if (targets.size === 0) return keys
    const all = Array.from(targets.values()).flat()
    const objectKeys = Array.from(new Set(all.map((t) => t.objectKey)))
    const objects = objectKeys.length
      ? await this.prisma.customObject.findMany({
          where: { key: { in: objectKeys }, deleted_at: null, is_active: true },
          select: { id: true, key: true },
        })
      : []
    const idByKey = new Map(objects.map((o) => [o.key, o.id]))
    const viewTargets = all.filter((t) => t.viewKey && idByKey.has(t.objectKey))
    const views = viewTargets.length
      ? await this.prisma.customView.findMany({
          where: {
            deleted_at: null,
            object_id: { in: Array.from(new Set(viewTargets.map((t) => idByKey.get(t.objectKey) as number))) },
            key: { in: Array.from(new Set(viewTargets.map((t) => t.viewKey as string))) },
          },
          select: { object_id: true, key: true },
        })
      : []
    const viewSet = new Set(views.map((v) => `${v.object_id}:${v.key}`))
    return keys.filter((k) => {
      const candidates = targets.get(k)
      if (!candidates) return true
      return candidates.some((t) => {
        const objectId = idByKey.get(t.objectKey)
        if (objectId === undefined) return false
        return t.viewKey === null || viewSet.has(`${objectId}:${t.viewKey}`)
      })
    })
  }
}
