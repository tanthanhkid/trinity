import type { CustomObject } from '@prisma/client';
import { ORG_FEATURE_KEYS, ORG_FEATURES, type OrgFeatureKey } from '@trinity/rbac';
import type { ObjectDef } from '../../../custom-objects/custom-object-access';
import { buildOptions } from '../../../custom-objects/field-definition';
import { TITLE_TYPES, type FieldDef } from '../../../custom-objects/field-types';
import type { MenuEntry } from '../../../custom-objects/custom-menu.service';
import type { ViewSpec } from '../../../custom-objects/view-config';
import { ActionUserError } from './action-types';
import { toFieldDto, type ObjectSpec } from './structure-spec';

/** Một view trong gói: thuộc bảng nào (khoá bảng trong gói hoặc bảng có sẵn). */
export interface PackageView extends ViewSpec { object: string; /** Lời người dùng gọi tên loại màn (kiểm bằng assertTypeChosen). */ type_words?: string }

/** Gói dựng quy trình: một nháp — duyệt một lần là dựng cả gói. */
export interface WorkspacePackage {
  title: string;
  objects: ObjectSpec[];
  views: PackageView[];
  menu: MenuEntry[] | null;
  features: OrgFeatureKey[];
}

export const MAX_PACKAGE_VIEWS = 20;

/** Định nghĩa GIẢ (chưa ghi) của một bảng trong gói — để kiểm view (trường chia cột có tồn tại, đúng kiểu) ngay lúc đề xuất. */
export function pseudoDef(spec: ObjectSpec): ObjectDef {
  const fields: FieldDef[] = [];
  let hasTitle = false;
  spec.fields.forEach((f, i) => {
    const options = buildOptions(f.type, toFieldDto(f, 1).options, fields, f.key);
    const isTitle = f.is_title ?? (!hasTitle && TITLE_TYPES.includes(f.type));
    hasTitle = hasTitle || isTitle;
    fields.push({ id: i + 1, key: f.key, label: f.label, type: f.type, required: !!f.required, is_unique: !!f.is_unique, is_title: isTitle, show_in_list: f.show_in_list ?? true, sort_order: (i + 1) * 10, options, help_text: null });
  });
  const obj = { id: 0, key: spec.key, label: spec.label, label_plural: spec.label_plural, icon: spec.icon ?? null, description: null, show_in_nav: true, nav_order: 0, visible_role_ids: [], is_active: true, code_prefix: spec.code_prefix ?? null, code_prefix_aliases: [], next_code_seq: null, created_by: null, created_at: new Date(0), updated_at: new Date(0), deleted_at: null } as CustomObject;
  return { obj, fields };
}

export function parseFeatures(raw: unknown): OrgFeatureKey[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ActionUserError('features phải là danh sách khoá tính năng.');
  const out = new Set<OrgFeatureKey>();
  for (const k of raw) {
    const key = String(k) as OrgFeatureKey;
    if (!(ORG_FEATURE_KEYS as readonly string[]).includes(key)) {
      throw new ActionUserError(`Tính năng “${String(k).slice(0, 40)}” không có. Dùng: ${ORG_FEATURE_KEYS.map((x) => `${x} (${ORG_FEATURES[x].label})`).join(', ')}.`);
    }
    out.add(key);
  }
  return [...out];
}

/** Menu mặc định khi AI không đặt: mỗi bảng mới một mục — ưu tiên view kanban đầu tiên của bảng, không có thì trang danh sách. */
export function defaultMenu(objects: ObjectSpec[], views: PackageView[]): MenuEntry[] {
  return objects.map((o) => {
    const k = views.find((v) => v.object === o.key && v.type === 'kanban');
    return k ? { object: o.key, view: k.key } : { object: o.key };
  });
}
