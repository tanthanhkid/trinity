import { Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'

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
    return { keys: user?.pinned_menu_keys ?? [] }
  }

  async update(userId: number, keys: string[]): Promise<PinnedMenuResponse> {
    const deduped = Array.from(new Set(keys))
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { pinned_menu_keys: deduped },
      select: { pinned_menu_keys: true },
    })
    return { keys: updated.pinned_menu_keys }
  }
}
