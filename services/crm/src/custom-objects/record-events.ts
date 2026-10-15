import type { CustomRecord } from '@prisma/client';
import type { CustomObjectEventRef, CustomRecordEventSnapshot } from '@trinity/prisma';
import type { ObjectDef } from './custom-object-access';
import { LIMITS, type RecordData } from './field-types';

/** Tiêu đề cache từ trường tiêu đề (≤200 ký tự); không có trường tiêu đề → null. */
export function titleOf(def: ObjectDef, data: RecordData): string | null {
  const f = def.fields.find((x) => x.is_title);
  const v = f ? data[f.key] : undefined;
  if (v === undefined || v === null) return null;
  const s = String(v).trim().slice(0, LIMITS.maxTitle);
  return s === '' ? null : s;
}

export function objectRef(def: ObjectDef): CustomObjectEventRef {
  const { obj } = def;
  return { id: obj.id, key: obj.key, label: obj.label, is_active: obj.is_active, visible_role_ids: obj.visible_role_ids };
}

/** Ảnh chụp THÔ cho outbox (xem `CustomRecordEventSnapshot`): chỉ trường sống, không công thức; SĐT liệt kê ở `phone_fields`. */
export function recordSnapshot(def: ObjectDef, row: Pick<CustomRecord, 'id' | 'title' | 'owner_id' | 'created_by' | 'data' | 'created_at' | 'updated_at'>): CustomRecordEventSnapshot {
  const raw = (row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {}) as RecordData;
  const data: RecordData = {};
  for (const f of def.fields) if (f.type !== 'formula' && raw[f.key] !== undefined) data[f.key] = raw[f.key];
  return {
    id: row.id,
    title: row.title,
    owner_id: row.owner_id,
    created_by: row.created_by,
    data,
    phone_fields: def.fields.filter((f) => f.type === 'phone').map((f) => f.key),
    created_at: row.created_at?.toISOString() ?? null,
    updated_at: row.updated_at?.toISOString() ?? null,
  };
}
