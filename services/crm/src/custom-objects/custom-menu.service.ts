import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';

/** Một mục menu: bảng (`object`) hoặc một view của bảng (`object` + `view`). `roles` = tên vai trò được thấy (rỗng = mọi người có quyền). */
export interface MenuEntry {
  object: string;
  view?: string;
  roles?: string[];
}

export const MAX_MENU_ENTRIES = 40;

/**
 * Đặt menu các bảng tuỳ biến + view: mục được liệt kê HIỆN theo đúng thứ tự; bảng/view KHÔNG liệt kê bị ẨN khỏi menu
 * (dữ liệu không đổi, vẫn mở được qua đường dẫn). Một giao dịch — lỗi thì không đổi gì. Chạy qua MCP (set_menu) theo quyền người kết nối; bước duyệt chỉ có khi bật ai_require_approval.
 */
@Injectable()
export class CustomMenuService {
  private readonly logger = new Logger(CustomMenuService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Kiểm (không ghi): mọi bảng/view tồn tại, không trùng, vai trò tồn tại. Trả về mục đã phân giải id. */
  async resolve(entries: MenuEntry[]) {
    if (entries.length === 0) throw new BadRequestException('Menu cần ít nhất một mục.');
    if (entries.length > MAX_MENU_ENTRIES) throw new BadRequestException(`Menu tối đa ${MAX_MENU_ENTRIES} mục.`);
    const objects = await this.prisma.customObject.findMany({ where: { deleted_at: null }, select: { id: true, key: true, label: true } });
    const views = await this.prisma.customView.findMany({ where: { deleted_at: null }, select: { id: true, key: true, object_id: true, label: true } });
    const roles = await this.prisma.role.findMany({ select: { id: true, name: true } });
    const seen = new Set<string>();
    return entries.map((e) => {
      const o = objects.find((x) => x.key === e.object);
      if (!o) throw new BadRequestException(`Không có bảng “${String(e.object).slice(0, 48)}”.`);
      const v = e.view ? views.find((x) => x.object_id === o.id && x.key === e.view) : undefined;
      if (e.view && !v) throw new BadRequestException(`Bảng “${o.label}” không có view “${String(e.view).slice(0, 48)}”.`);
      const id = `${o.key}__${v?.key ?? ''}`;
      if (seen.has(id)) throw new BadRequestException(`Mục menu “${v?.label ?? o.label}” bị lặp.`);
      seen.add(id);
      const roleIds = (e.roles ?? []).map((name) => {
        const r = roles.find((x) => x.name.trim().toLowerCase() === String(name).trim().toLowerCase());
        if (!r) throw new BadRequestException(`Không có vai trò “${String(name).slice(0, 60)}”. Vai trò hiện có: ${roles.map((x) => x.name).slice(0, 15).join(', ')}.`);
        return r.id;
      });
      return { objectId: o.id, viewId: v?.id ?? null, label: v?.label ?? o.label, roleIds, rolesGiven: e.roles !== undefined };
    });
  }

  async apply(entries: MenuEntry[], user: AuthUser): Promise<{ shown: number }> {
    const items = await this.resolve(entries);
    await this.prisma.$transaction(async (tx) => {
      await tx.customObject.updateMany({ where: { deleted_at: null }, data: { show_in_nav: false } });
      await tx.customView.updateMany({ where: { deleted_at: null }, data: { show_in_nav: false } });
      for (const [i, it] of items.entries()) {
        const roleData = it.rolesGiven ? { visible_role_ids: it.roleIds } : {};
        if (it.viewId) await tx.customView.update({ where: { id: it.viewId }, data: { show_in_nav: true, nav_order: i + 1, ...roleData } });
        else await tx.customObject.update({ where: { id: it.objectId }, data: { show_in_nav: true, nav_order: i + 1, ...roleData } });
      }
    });
    this.logger.log(`menu tuỳ biến đặt lại bởi user ${user.userId}: ${items.length} mục`);
    return { shown: items.length };
  }
}
