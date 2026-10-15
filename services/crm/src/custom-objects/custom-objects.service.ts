import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import {
  isObjectVisible, loadObjectAccess, loadVisibleObject, presentObject, toFieldDef, type ObjectDef,
} from './custom-object-access';
import { CUSTOM_ICONS, KEY_REGEX, LIMITS, RESERVED_OBJECT_KEYS, type FieldDef } from './field-types';
import type { CreateCustomObjectDto, UpdateCustomObjectDto } from './dto/custom-object.dto';
import { isViewVisible } from './custom-views.service';
import { normalizePrefix, prefixTaken, renamePrefix } from './record-codes';

/**
 * Định nghĩa thực thể tuỳ biến: tạo / sửa / xoá mềm / danh sách / menu. Quyền `custom_objects.manage`
 * (cấu hình) và `custom_records.view` (menu) do controller gác; `visible_role_ids` chỉ THU HẸP, không cấp quyền.
 */
@Injectable()
export class CustomObjectsService {
  private readonly logger = new Logger(CustomObjectsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const [objects, fieldCounts, recordCounts] = await Promise.all([
      this.prisma.customObject.findMany({ where: { deleted_at: null }, orderBy: [{ nav_order: 'asc' }, { id: 'asc' }] }),
      this.prisma.customField.groupBy({ by: ['object_id'], where: { deleted_at: null }, _count: { _all: true } }),
      this.prisma.customRecord.groupBy({ by: ['object_id'], where: { deleted_at: null }, _count: { _all: true } }),
    ]);
    const fc = new Map(fieldCounts.map((r) => [r.object_id, r._count._all]));
    const rc = new Map(recordCounts.map((r) => [r.object_id, r._count._all]));
    return objects.map((o) => ({
      id: o.id, key: o.key, label: o.label, label_plural: o.label_plural, icon: o.icon, description: o.description,
      show_in_nav: o.show_in_nav, nav_order: o.nav_order, visible_role_ids: o.visible_role_ids, is_active: o.is_active,
      code_prefix: o.code_prefix,
      field_count: fc.get(o.id) ?? 0, record_count: rc.get(o.id) ?? 0,
    }));
  }

  /**
   * Menu: thực thể BẬT + hiện menu + người này được thấy (theo vai trò), cùng các VIEW gắn menu của thực thể
   * người này thấy được. Chung một thứ tự `nav_order` (set_menu đánh số liên tục cho cả hai).
   */
  async nav(user: AuthUser) {
    const access = await loadObjectAccess(this.prisma, user);
    const objects = await this.prisma.customObject.findMany({
      where: { deleted_at: null, is_active: true },
      orderBy: [{ nav_order: 'asc' }, { id: 'asc' }],
      select: { id: true, key: true, label: true, label_plural: true, icon: true, nav_order: true, show_in_nav: true, visible_role_ids: true, is_active: true, deleted_at: true },
      take: LIMITS.maxObjects + 10,
    });
    const visible = objects.filter((r) => isObjectVisible(r, access));
    const byId = new Map(visible.map((o) => [o.id, o]));
    const views = byId.size === 0 ? [] : await this.prisma.customView.findMany({
      where: { deleted_at: null, show_in_nav: true, object_id: { in: [...byId.keys()] } },
      select: { object_id: true, key: true, label: true, icon: true, nav_order: true, visible_role_ids: true, deleted_at: true },
      take: 200,
    });
    const items = [
      ...visible.filter((o) => o.show_in_nav).map((o) => ({ key: o.key, label: o.label, label_plural: o.label_plural, icon: o.icon, nav_order: o.nav_order, href: `/x/${o.key}`, menu_key: o.key })),
      ...views.filter((v) => isViewVisible(v, access)).map((v) => {
        const o = byId.get(v.object_id) as (typeof visible)[number];
        return { key: o.key, label: v.label, label_plural: v.label, icon: v.icon ?? o.icon, nav_order: v.nav_order, href: `/x/${o.key}/v/${v.key}`, menu_key: `${o.key}__${v.key}` };
      }),
    ];
    return items.sort((a, b) => a.nav_order - b.nav_order || a.menu_key.localeCompare(b.menu_key));
  }

  async getDefinition(user: AuthUser, key: string) {
    const def = await loadVisibleObject(this.prisma, user, key);
    return presentObject({ ...def, fields: await this.withTargetKeys(user, def.fields) });
  }

  /** Gắn `target_key`/`target_label` cho trường liên kết — chỉ khi người xem thấy được thực thể đích (không lộ tên thực thể bị ẩn). */
  private async withTargetKeys(user: AuthUser, fields: FieldDef[]): Promise<FieldDef[]> {
    const ids = [...new Set(fields.filter((f) => f.type === 'relation' && f.options.target_object_id).map((f) => f.options.target_object_id as number))];
    if (ids.length === 0) return fields;
    const [access, targets] = await Promise.all([
      loadObjectAccess(this.prisma, user),
      this.prisma.customObject.findMany({ where: { id: { in: ids }, deleted_at: null } }),
    ]);
    const visible = new Map(targets.filter((t) => isObjectVisible(t, access)).map((t) => [t.id, t]));
    return fields.map((f) => {
      const t = f.type === 'relation' && f.options.target_object_id ? visible.get(f.options.target_object_id) : undefined;
      return t ? { ...f, options: { ...f.options, target_key: t.key, target_label: t.label_plural } } : f;
    });
  }

  async create(dto: CreateCustomObjectDto, user: AuthUser) {
    this.assertKey(dto.key);
    if (!dto.label.trim() || !dto.label_plural.trim()) throw new BadRequestException('Tên không được để trống');
    const icon = this.checkIcon(dto.icon);
    const roles = await this.checkRoleIds(dto.visible_role_ids);
    const [live, taken, maxOrder] = await Promise.all([
      this.prisma.customObject.count({ where: { deleted_at: null } }),
      this.prisma.customObject.findFirst({ where: { key: dto.key, deleted_at: null }, select: { id: true } }),
      this.prisma.customObject.aggregate({ where: { deleted_at: null }, _max: { nav_order: true } }),
    ]);
    if (live >= LIMITS.maxObjects) throw new BadRequestException(`Tối đa ${LIMITS.maxObjects} tính năng tuỳ biến`);
    if (taken) throw new ConflictException(`Mã “${dto.key}” đã được dùng`);
    const codePrefix = dto.code_prefix ? normalizePrefix(dto.code_prefix) : null;
    if (codePrefix && (await prefixTaken(this.prisma, codePrefix, null))) throw new ConflictException(`Tiền tố mã “${codePrefix}” đã được bảng khác dùng`);
    try {
      const obj = await this.prisma.customObject.create({
        data: {
          key: dto.key,
          label: dto.label.trim(),
          label_plural: dto.label_plural.trim(),
          icon,
          description: dto.description?.trim() || null,
          show_in_nav: dto.show_in_nav ?? true,
          nav_order: dto.nav_order ?? (maxOrder._max.nav_order ?? 0) + 1,
          visible_role_ids: roles,
          is_active: dto.is_active ?? true,
          // null ⇒ trigger DB tự sinh từ tên (duy nhất toàn hệ thống).
          code_prefix: codePrefix,
          created_by: user.userId,
        },
      });
      this.logger.log(`custom_object ${obj.key} tạo bởi user ${user.userId}`);
      return presentObject({ obj, fields: [] });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(`Mã “${dto.key}” đã được dùng`);
      throw e;
    }
  }

  async update(key: string, dto: UpdateCustomObjectDto, user: AuthUser) {
    const def = await loadVisibleObject(this.prisma, user, key);
    if ((dto.label !== undefined && !dto.label.trim()) || (dto.label_plural !== undefined && !dto.label_plural.trim())) {
      throw new BadRequestException('Tên không được để trống');
    }
    const data: Prisma.CustomObjectUpdateInput = {};
    if (dto.label !== undefined) data.label = dto.label.trim();
    if (dto.label_plural !== undefined) data.label_plural = dto.label_plural.trim();
    if (dto.icon !== undefined) data.icon = this.checkIcon(dto.icon);
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.show_in_nav !== undefined) data.show_in_nav = dto.show_in_nav;
    if (dto.nav_order !== undefined) data.nav_order = dto.nav_order;
    if (dto.is_active !== undefined) data.is_active = dto.is_active;
    if (dto.visible_role_ids !== undefined) data.visible_role_ids = await this.checkRoleIds(dto.visible_role_ids);
    if (dto.code_prefix !== undefined) await renamePrefix(this.prisma, def.obj.id, dto.code_prefix);
    const obj = await this.prisma.customObject.update({ where: { id: def.obj.id }, data });
    this.logger.log(`custom_object ${key} sửa bởi user ${user.userId}: ${[...Object.keys(data), ...(dto.code_prefix !== undefined ? ['code_prefix'] : [])].join(',')}`);
    return presentObject({ obj, fields: def.fields });
  }

  /** Xoá mềm. Chặn nếu còn trường liên kết của thực thể khác trỏ tới (tránh liên kết treo). */
  async remove(key: string, user: AuthUser) {
    const def = await loadVisibleObject(this.prisma, user, key);
    const refs = await this.prisma.customField.findMany({
      where: { deleted_at: null, type: 'relation', object_id: { not: def.obj.id }, object: { deleted_at: null }, options: { path: ['target_object_id'], equals: def.obj.id } },
      select: { label: true, object: { select: { label: true } } },
      take: 10,
    });
    if (refs.length > 0) {
      const names = refs.map((r) => `${r.object.label} › ${r.label}`).join(', ');
      throw new ConflictException(`Không xoá được: còn trường liên kết trỏ tới “${def.obj.label}” (${names}). Hãy xoá/đổi các trường đó trước.`);
    }
    await this.prisma.customObject.update({ where: { id: def.obj.id }, data: { deleted_at: new Date() } });
    this.logger.warn(`custom_object ${key} xoá mềm bởi user ${user.userId}`);
    return { ok: true };
  }

  /** Nạp định nghĩa theo id (cho các service khác). 404 nếu đã xoá. */
  async getDefById(id: number): Promise<ObjectDef> {
    const obj = await this.prisma.customObject.findFirst({ where: { id, deleted_at: null } });
    if (!obj) throw new NotFoundException('Không tìm thấy tính năng này');
    const rows = await this.prisma.customField.findMany({ where: { object_id: id, deleted_at: null }, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] });
    return { obj, fields: rows.map(toFieldDef) };
  }

  private assertKey(key: string): void {
    if (!KEY_REGEX.test(key)) throw new BadRequestException('Mã chỉ gồm a-z, 0-9, _ , bắt đầu bằng chữ, tối đa 48 ký tự');
    if (RESERVED_OBJECT_KEYS.includes(key)) throw new BadRequestException(`Mã “${key}” là từ khoá của hệ thống, hãy chọn mã khác`);
  }

  private checkIcon(icon: string | null | undefined): string | null {
    if (icon === undefined || icon === null || icon === '') return null;
    if (!(CUSTOM_ICONS as readonly string[]).includes(icon)) throw new BadRequestException('Biểu tượng không nằm trong danh sách cho phép');
    return icon;
  }

  private async checkRoleIds(ids: number[] | undefined): Promise<number[]> {
    const uniq = [...new Set(ids ?? [])];
    if (uniq.length === 0) return [];
    const found = await this.prisma.role.count({ where: { id: { in: uniq } } });
    if (found !== uniq.length) throw new BadRequestException('Có vai trò không tồn tại trong danh sách “được thấy”');
    return uniq;
  }
}
