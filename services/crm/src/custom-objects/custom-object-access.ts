import { NotFoundException } from '@nestjs/common';
import type { CustomField, CustomObject } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { isFieldType, type FieldDef, type FieldOptions } from './field-types';

/** Thực thể + các trường CÒN SỐNG (đã sắp theo `sort_order`). */
export interface ObjectDef {
  obj: CustomObject;
  fields: FieldDef[];
}

export interface ObjectAccess {
  roleIds: number[];
  /** Giữ `custom_objects.manage` → thấy MỌI thực thể (kể cả tắt / ngoài `visible_role_ids`) để còn cấu hình. */
  canManage: boolean;
}

export function toFieldDef(row: CustomField): FieldDef {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: isFieldType(row.type) ? row.type : 'text',
    required: row.required,
    is_unique: row.is_unique,
    is_title: row.is_title,
    show_in_list: row.show_in_list,
    sort_order: row.sort_order,
    options: (row.options && typeof row.options === 'object' && !Array.isArray(row.options) ? row.options : {}) as FieldOptions,
    help_text: row.help_text,
  };
}

export async function loadObjectAccess(prisma: PrismaService, user: AuthUser): Promise<ObjectAccess> {
  const rows = await prisma.userRole.findMany({ where: { user_id: user.userId }, select: { role_id: true } });
  return { roleIds: rows.map((r) => r.role_id), canManage: can(user.grants, 'custom_objects.manage') };
}

/** Thực thể có hiện cho người này không (BE là cổng thật; FE chỉ phản chiếu). */
export function isObjectVisible(
  obj: Pick<CustomObject, 'is_active' | 'deleted_at' | 'visible_role_ids'>,
  access: ObjectAccess,
): boolean {
  if (obj.deleted_at) return false;
  if (access.canManage) return true;
  if (!obj.is_active) return false;
  return obj.visible_role_ids.length === 0 || obj.visible_role_ids.some((id) => access.roleIds.includes(id));
}

/** Nạp thực thể theo key + trường sống; 404 (không 403) nếu không tồn tại hoặc không được thấy. */
export async function loadVisibleObject(
  prisma: PrismaService,
  user: AuthUser,
  key: string,
  access?: ObjectAccess,
): Promise<ObjectDef> {
  const obj = await prisma.customObject.findFirst({ where: { key, deleted_at: null } });
  const acc = access ?? (await loadObjectAccess(prisma, user));
  if (!obj || !isObjectVisible(obj, acc)) throw new NotFoundException('Không tìm thấy tính năng này');
  const rows = await prisma.customField.findMany({
    where: { object_id: obj.id, deleted_at: null },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });
  return { obj, fields: rows.map(toFieldDef) };
}

export function presentObject(def: ObjectDef) {
  const { obj, fields } = def;
  return {
    id: obj.id,
    key: obj.key,
    label: obj.label,
    label_plural: obj.label_plural,
    icon: obj.icon,
    description: obj.description,
    show_in_nav: obj.show_in_nav,
    nav_order: obj.nav_order,
    visible_role_ids: obj.visible_role_ids,
    is_active: obj.is_active,
    code_prefix: obj.code_prefix,
    code_prefix_aliases: obj.code_prefix_aliases,
    created_at: obj.created_at,
    updated_at: obj.updated_at,
    fields,
  };
}
