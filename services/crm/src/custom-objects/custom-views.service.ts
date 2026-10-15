import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type CustomView } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadObjectAccess, loadVisibleObject, type ObjectAccess, type ObjectDef } from './custom-object-access';
import { pruneStaleFilter } from './record-query';
import { assertViewMeta, MAX_VIEWS_PER_OBJECT, normalizeViewConfig, type ViewConfig, type ViewSpec, type ViewType } from './view-config';

type Db = Pick<PrismaService, 'customView'> | Prisma.TransactionClient;

export interface ViewDto {
  id: number;
  key: string;
  object_key: string;
  label: string;
  type: ViewType;
  config: ViewConfig;
  icon: string | null;
  show_in_nav: boolean;
  nav_order: number;
  href: string;
}

const viewHref = (objectKey: string, viewKey: string): string => `/x/${objectKey}/v/${viewKey}`;

/** Bộ lọc đã lưu mà lựa chọn/trường về sau bị xoá ⇒ bỏ điều kiện hỏng, để view vẫn mở được (không 400). */
export function presentViewFor(def: ObjectDef, v: CustomView, objectKey: string): ViewDto {
  const dto = presentView(v, objectKey);
  const filter = dto.config.filter;
  if (filter && typeof filter === 'object') dto.config = { ...dto.config, filter: pruneStaleFilter(def, filter) };
  return dto;
}

export function presentView(v: CustomView, objectKey: string): ViewDto {
  return {
    id: v.id, key: v.key, object_key: objectKey, label: v.label, type: v.type as ViewType,
    config: (v.config && typeof v.config === 'object' ? v.config : {}) as ViewConfig, icon: v.icon,
    show_in_nav: v.show_in_nav, nav_order: v.nav_order, href: viewHref(objectKey, v.key),
  };
}

export function isViewVisible(v: Pick<CustomView, 'visible_role_ids' | 'deleted_at'>, access: ObjectAccess): boolean {
  if (v.deleted_at) return false;
  return access.canManage || v.visible_role_ids.length === 0 || v.visible_role_ids.some((id) => access.roleIds.includes(id));
}

/**
 * Màn xem của bảng tuỳ biến. ĐỌC: ai thấy bảng thì thấy view (thu hẹp thêm theo `visible_role_ids`). GHI: không có form tay —
 * AI ghi qua MCP (create_view / update_view / set_menu / propose_workspace) theo đúng quyền của người đã kết nối; bước duyệt
 * của quản trị viên chỉ có khi bật tuỳ chọn `ai_require_approval` (mặc định TẮT).
 */
@Injectable()
export class CustomViewsService {
  private readonly logger = new Logger(CustomViewsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, objectKey: string): Promise<ViewDto[]> {
    const def = await loadVisibleObject(this.prisma, user, objectKey);
    const access = await loadObjectAccess(this.prisma, user);
    const rows = await this.prisma.customView.findMany({ where: { object_id: def.obj.id, deleted_at: null }, orderBy: [{ nav_order: 'asc' }, { id: 'asc' }], take: MAX_VIEWS_PER_OBJECT * 2 });
    return rows.filter((v) => isViewVisible(v, access)).map((v) => presentViewFor(def, v, objectKey));
  }

  async get(user: AuthUser, objectKey: string, viewKey: string): Promise<ViewDto> {
    const def = await loadVisibleObject(this.prisma, user, objectKey);
    const v = await this.prisma.customView.findFirst({ where: { object_id: def.obj.id, key: viewKey, deleted_at: null } });
    if (!v || !isViewVisible(v, await loadObjectAccess(this.prisma, user))) throw new NotFoundException('Không tìm thấy màn xem này');
    return presentViewFor(def, v, objectKey);
  }

  /** Kiểm một view mới cho bảng `def` (chưa ghi). `taken` = khoá view đã dùng của bảng. */
  check(def: ObjectDef, spec: ViewSpec, taken: string[]): ViewSpec {
    assertViewMeta(spec.key, spec.label, spec.type, spec.icon);
    if (taken.includes(spec.key)) throw new ConflictException(`Bảng “${def.obj.label}” đã có view khoá “${spec.key}”.`);
    if (taken.length >= MAX_VIEWS_PER_OBJECT) throw new BadRequestException(`Mỗi bảng tối đa ${MAX_VIEWS_PER_OBJECT} view.`);
    return { ...spec, config: normalizeViewConfig(def, spec.type, spec.config) };
  }

  async create(def: ObjectDef, spec: ViewSpec, user: AuthUser, db: Db = this.prisma): Promise<CustomView> {
    const taken = (await db.customView.findMany({ where: { object_id: def.obj.id, deleted_at: null }, select: { key: true } })).map((v) => v.key);
    const ok = this.check(def, spec, taken);
    const max = await db.customView.aggregate({ where: { deleted_at: null }, _max: { nav_order: true } });
    const row = await db.customView.create({
      data: {
        object_id: def.obj.id, key: ok.key, label: ok.label.trim(), type: ok.type, config: ok.config as Prisma.InputJsonObject,
        icon: ok.icon ?? null, show_in_nav: ok.show_in_nav ?? false, nav_order: (max._max.nav_order ?? 0) + 1, created_by: user.userId,
      },
    });
    this.logger.log(`custom_view ${def.obj.key}.${ok.key} (${ok.type}) tạo bởi user ${user.userId}`);
    return row;
  }

  async update(def: ObjectDef, viewKey: string, patch: Partial<Omit<ViewSpec, 'key'>> & { is_deleted?: boolean }, user: AuthUser): Promise<CustomView> {
    const cur = await this.prisma.customView.findFirst({ where: { object_id: def.obj.id, key: viewKey, deleted_at: null } });
    if (!cur) throw new NotFoundException(`Bảng “${def.obj.label}” không có view “${viewKey}”.`);
    const type = (patch.type ?? cur.type) as ViewType;
    const label = patch.label ?? cur.label;
    assertViewMeta(viewKey, label, type, patch.icon === undefined ? cur.icon : patch.icon);
    const config = patch.config !== undefined || patch.type !== undefined ? normalizeViewConfig(def, type, patch.config ?? presentViewFor(def, cur, def.obj.key).config) : undefined;
    const row = await this.prisma.customView.update({
      where: { id: cur.id },
      data: {
        label: label.trim(), type, ...(config ? { config: config as Prisma.InputJsonObject } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}), ...(patch.show_in_nav !== undefined ? { show_in_nav: patch.show_in_nav } : {}),
        ...(patch.is_deleted ? { deleted_at: new Date(), show_in_nav: false } : {}),
      },
    });
    this.logger.log(`custom_view ${def.obj.key}.${viewKey} sửa bởi user ${user.userId}`);
    return row;
  }
}
