import { Prisma } from '@prisma/client';
import type { ObjectDef } from '../../custom-objects/custom-object-access';

/**
 * Danh mục bảng nguồn cho báo cáo dùng chung (#25): bảng lõi (khách hàng, deal) + mọi bảng tuỳ biến, mỗi bảng
 * khai các trường dùng được theo VAI: `date` (chia kỳ), `number` (cộng tổng), `group` (nhóm). Biểu thức SQL dựng
 * từ khoá trường đã đối chiếu với danh mục — không bao giờ nội suy chuỗi người dùng gửi.
 */

export type FieldRole = 'date' | 'number' | 'group';

/** Cách đổi giá trị nhóm thô (mã) ra nhãn. */
export type GroupLabels =
  | { kind: 'map'; labels: Record<string, string> }
  | { kind: 'user' }
  | { kind: 'option' }
  | { kind: 'contact' }
  | { kind: 'record'; objectId: number }
  | { kind: 'raw' };

export interface SourceField {
  key: string;
  label: string;
  role: FieldRole;
  /** date ⇒ biểu thức kiểu `date` (NULL nếu trống/sai) · number ⇒ `float8` · group ⇒ `text`. */
  expr: Prisma.Sql;
  labels?: GroupLabels;
}

export interface ReportSourceSpec {
  source: string;
  label: string;
  table: 'contacts' | 'deals' | 'custom_records';
  /** Điều kiện nền (bỏ dòng đã xoá, đúng bảng tuỳ biến). */
  base: Prisma.Sql;
  /** Quyền xem (có phạm vi) quyết định dòng nào được đếm — số trên báo cáo khớp danh sách người xem thấy. */
  scopePerm: 'contacts.view' | 'deals.view' | 'custom_records.view';
  ownerCols: readonly string[];
  fields: SourceField[];
}

const vnDate = (col: string) => Prisma.sql`(${Prisma.raw(col)} AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
const col = (c: string) => Prisma.raw(c);

const CONTACTS: ReportSourceSpec = {
  source: 'contacts',
  label: 'Khách hàng',
  table: 'contacts',
  base: Prisma.sql`deleted_at IS NULL`,
  scopePerm: 'contacts.view',
  ownerCols: ['assigned_to', 'created_by_id'],
  fields: [
    { key: 'created_at', label: 'Ngày tạo', role: 'date', expr: vnDate('created_at') },
    { key: 'lead_score', label: 'Điểm tiềm năng', role: 'number', expr: Prisma.sql`lead_score::float8` },
    { key: 'stage_id', label: 'Giai đoạn', role: 'group', expr: Prisma.sql`stage_id::text`, labels: { kind: 'option' } },
    { key: 'source_id', label: 'Nguồn', role: 'group', expr: Prisma.sql`source_id::text`, labels: { kind: 'option' } },
    { key: 'contact_status_id', label: 'Tình trạng', role: 'group', expr: Prisma.sql`contact_status_id::text`, labels: { kind: 'option' } },
    { key: 'assigned_to', label: 'Người phụ trách', role: 'group', expr: Prisma.sql`assigned_to::text`, labels: { kind: 'user' } },
    { key: 'lead_label', label: 'Nhãn tiềm năng', role: 'group', expr: col('lead_label'), labels: { kind: 'map', labels: { hot: 'Nóng', warm: 'Ấm', cold: 'Lạnh' } } },
  ],
};

const DEALS: ReportSourceSpec = {
  source: 'deals',
  label: 'Deal',
  table: 'deals',
  base: Prisma.sql`TRUE`,
  scopePerm: 'deals.view',
  ownerCols: ['assigned_to', 'created_by'],
  fields: [
    { key: 'created_at', label: 'Ngày tạo', role: 'date', expr: vnDate('created_at') },
    { key: 'won_at', label: 'Ngày chốt thắng', role: 'date', expr: vnDate('won_at') },
    { key: 'value', label: 'Giá trị', role: 'number', expr: Prisma.sql`value::float8` },
    { key: 'status', label: 'Trạng thái', role: 'group', expr: col('status'), labels: { kind: 'map', labels: { open: 'Đang mở', won: 'Thắng', lost: 'Thua' } } },
    { key: 'assigned_to', label: 'Người phụ trách', role: 'group', expr: Prisma.sql`assigned_to::text`, labels: { kind: 'user' } },
  ],
};

export const CORE_SOURCES: readonly ReportSourceSpec[] = [CONTACTS, DEALS];

const YMD = '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])';
const NUM = '^-?[0-9]+(\\.[0-9]+)?$';

/** Bảng tuỳ biến → nguồn báo cáo: ngày tạo/cập nhật + trường date/datetime; số/tiền/%; lựa chọn/người dùng/liên kết đơn. */
export function customSource(def: ObjectDef): ReportSourceSpec {
  const fields: SourceField[] = [
    { key: 'created_at', label: 'Ngày tạo', role: 'date', expr: vnDate('created_at') },
    { key: 'updated_at', label: 'Ngày cập nhật', role: 'date', expr: vnDate('updated_at') },
  ];
  for (const f of def.fields) {
    const txt = Prisma.sql`(data->>${f.key})`;
    if (f.type === 'date') {
      fields.push({ key: f.key, label: f.label, role: 'date', expr: Prisma.sql`CASE WHEN ${txt} ~ ${`${YMD}$`} THEN ${txt}::date END` });
    } else if (f.type === 'datetime') {
      fields.push({ key: f.key, label: f.label, role: 'date', expr: Prisma.sql`CASE WHEN ${txt} ~ ${`${YMD}T`} THEN (${txt}::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date END` });
    } else if (f.type === 'number' || f.type === 'currency' || f.type === 'percent') {
      fields.push({ key: f.key, label: f.label, role: 'number', expr: Prisma.sql`CASE WHEN ${txt} ~ ${NUM} THEN ${txt}::float8 END` });
    } else if (f.type === 'select') {
      const labels = Object.fromEntries((f.options.choices ?? []).map((c) => [c.value, c.label]));
      fields.push({ key: f.key, label: f.label, role: 'group', expr: txt, labels: { kind: 'map', labels } });
    } else if (f.type === 'user') {
      fields.push({ key: f.key, label: f.label, role: 'group', expr: txt, labels: { kind: 'user' } });
    } else if (f.type === 'relation' && !f.options.multiple && (f.options.target === 'contact' || f.options.target_object_id)) {
      const labels: GroupLabels = f.options.target === 'contact' ? { kind: 'contact' } : { kind: 'record', objectId: f.options.target_object_id! };
      fields.push({ key: f.key, label: f.label, role: 'group', expr: txt, labels });
    }
  }
  return {
    source: `x:${def.obj.key}`,
    label: def.obj.label_plural ?? def.obj.label,
    table: 'custom_records',
    base: Prisma.sql`object_id = ${def.obj.id} AND deleted_at IS NULL`,
    scopePerm: 'custom_records.view',
    ownerCols: ['owner_id', 'created_by'],
    fields,
  };
}

export function findField(spec: ReportSourceSpec, key: string, role: FieldRole): SourceField | undefined {
  return spec.fields.find((f) => f.key === key && f.role === role);
}
