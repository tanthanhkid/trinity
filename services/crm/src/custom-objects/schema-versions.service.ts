import { NotFoundException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type CustomField, type CustomObject, type CustomView } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { LIMITS } from './field-types';
import { MAX_VIEWS_PER_OBJECT } from './view-config';

/** Ảnh chụp cấu trúc (không có dữ liệu bản ghi). Ngày giờ lưu dạng chuỗi ISO trong JSON. */
export interface StructureSnapshot {
  objects: CustomObject[];
  fields: CustomField[];
  views: CustomView[];
  /** Giá trị thô `settings.org_features` lúc chụp (null = chưa lưu). */
  features: string | null;
}

export interface StructureDiff {
  /** Bảng bị ẩn (tạo sau phiên bản) / hiện lại / đổi trường. */
  tables: { key: string; label: string; records: number; change: string }[];
  affected_records: number;
}

const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const sameField = (a: CustomField, b: CustomField): boolean =>
  a.label === b.label && a.type === b.type && a.required === b.required && a.is_unique === b.is_unique && a.is_title === b.is_title &&
  a.show_in_list === b.show_in_list && a.sort_order === b.sort_order && JSON.stringify(a.options) === JSON.stringify(b.options) && a.help_text === b.help_text;

/**
 * Phiên bản cấu trúc bảng tuỳ biến: chụp TRƯỚC mỗi lần đổi cấu trúc, và quay lui về một phiên bản.
 * Quay lui chỉ đổi ĐỊNH NGHĨA (bảng/trường/view/menu/tính năng) — dữ liệu bản ghi (JSONB) không bị xoá: trường bị ẩn vẫn giữ dữ liệu.
 */
@Injectable()
export class SchemaVersionsService {
  private readonly logger = new Logger(SchemaVersionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async snapshot(): Promise<StructureSnapshot> {
    const [objects, fields, views, features] = await Promise.all([
      this.prisma.customObject.findMany({ where: { deleted_at: null }, take: LIMITS.maxObjects + 10 }),
      this.prisma.customField.findMany({ where: { deleted_at: null, object: { deleted_at: null } }, take: (LIMITS.maxObjects + 10) * LIMITS.maxFieldsPerObject }),
      this.prisma.customView.findMany({ where: { deleted_at: null, object: { deleted_at: null } }, orderBy: { id: 'asc' }, take: (LIMITS.maxObjects + 10) * MAX_VIEWS_PER_OBJECT }),
      this.prisma.setting.findUnique({ where: { key: 'org_features' }, select: { value: true } }),
    ]);
    return { objects, fields, views, features: features?.value ?? null };
  }

  async save(draftId: number | null, tool: string, summary: string, userId: number): Promise<number> {
    const row = await this.prisma.customSchemaVersion.create({
      data: { draft_id: draftId, tool, summary: summary.slice(0, 1000), snapshot: json(await this.snapshot()), created_by: userId },
      select: { id: true },
    });
    return row.id;
  }

  async list(limit = 20) {
    return this.prisma.customSchemaVersion.findMany({ orderBy: { id: 'desc' }, take: Math.min(Math.max(limit, 1), 50), select: { id: true, tool: true, summary: true, created_at: true, created_by: true, draft_id: true } });
  }

  async load(id: number): Promise<StructureSnapshot> {
    const v = await this.prisma.customSchemaVersion.findUnique({ where: { id } });
    if (!v) throw new NotFoundException(`Không có phiên bản cấu trúc #${id}.`);
    return v.snapshot as unknown as StructureSnapshot;
  }

  /** So cấu trúc HIỆN TẠI với phiên bản: bảng nào bị ẩn / hiện lại / đổi trường, kèm số bản ghi bị ảnh hưởng. */
  async diff(target: StructureSnapshot): Promise<StructureDiff> {
    const now = await this.snapshot();
    const keep = new Set(target.objects.map((o) => o.id));
    const tables: StructureDiff['tables'] = [];
    const counts = await this.prisma.customRecord.groupBy({ by: ['object_id'], where: { deleted_at: null }, _count: { _all: true } });
    const n = (id: number): number => counts.find((c) => c.object_id === id)?._count._all ?? 0;
    for (const o of now.objects) if (!keep.has(o.id)) tables.push({ key: o.key, label: o.label, records: n(o.id), change: 'bảng tạo sau phiên bản này sẽ bị ẨN (dữ liệu giữ trong hệ thống)' });
    for (const o of target.objects) {
      const cur = now.objects.find((x) => x.id === o.id);
      if (!cur) { tables.push({ key: o.key, label: o.label, records: n(o.id), change: 'bảng được HIỆN LẠI' }); continue; }
      const tf = target.fields.filter((f) => f.object_id === o.id);
      const nf = now.fields.filter((f) => f.object_id === o.id);
      const added = nf.filter((f) => !tf.some((t) => t.id === f.id)).map((f) => f.label);
      const restored = tf.filter((t) => !nf.some((f) => f.id === t.id)).map((f) => f.label);
      const changed = tf.filter((t) => { const f = nf.find((x) => x.id === t.id); return f && !sameField(f, t); }).map((f) => f.label);
      const parts = [added.length && `ẩn ${added.join(', ')}`, restored.length && `hiện lại ${restored.join(', ')}`, changed.length && `trả định nghĩa ${changed.join(', ')}`].filter(Boolean);
      if (parts.length) tables.push({ key: o.key, label: o.label, records: n(o.id), change: parts.join('; ') });
    }
    return { tables, affected_records: tables.reduce((s, t) => s + t.records, 0) };
  }

  /** Quay lui về phiên bản `id` trong MỘT giao dịch. Trường/bảng/view không có trong phiên bản bị ẩn (xoá mềm), không xoá dữ liệu. */
  async restore(id: number, userId: number): Promise<{ restored_version: number }> {
    const t = await this.load(id);
    const at = new Date();
    await this.prisma.$transaction(async (tx) => {
      const objIds = t.objects.map((o) => o.id);
      await tx.customObject.updateMany({ where: { deleted_at: null, id: { notIn: objIds } }, data: { deleted_at: at } });
      for (const o of t.objects) {
        await tx.customObject.update({ where: { id: o.id }, data: { label: o.label, label_plural: o.label_plural, icon: o.icon, description: o.description, show_in_nav: o.show_in_nav, nav_order: o.nav_order, visible_role_ids: o.visible_role_ids, is_active: o.is_active, deleted_at: null } });
      }
      const fieldIds = t.fields.map((f) => f.id);
      await tx.customField.updateMany({ where: { deleted_at: null, object_id: { in: objIds }, id: { notIn: fieldIds } }, data: { deleted_at: at } });
      await tx.customField.updateMany({ where: { object_id: { in: objIds }, is_title: true }, data: { is_title: false } });
      for (const f of t.fields) {
        await tx.customField.update({ where: { id: f.id }, data: { label: f.label, type: f.type, required: f.required, is_unique: f.is_unique, is_title: f.is_title, show_in_list: f.show_in_list, sort_order: f.sort_order, options: json(f.options), help_text: f.help_text, deleted_at: null } });
      }
      const viewIds = t.views.map((v) => v.id);
      await tx.customView.updateMany({ where: { deleted_at: null, id: { notIn: viewIds } }, data: { deleted_at: at, show_in_nav: false } });
      for (const v of t.views) {
        await tx.customView.update({ where: { id: v.id }, data: { label: v.label, type: v.type, config: json(v.config), icon: v.icon, show_in_nav: v.show_in_nav, nav_order: v.nav_order, visible_role_ids: v.visible_role_ids, deleted_at: null } });
      }
      for (const f of t.fields.filter((x) => x.is_title)) {
        await tx.$executeRaw(Prisma.sql`UPDATE custom_records SET title = NULLIF(left(data ->> ${f.key}, ${LIMITS.maxTitle}::int), '') WHERE object_id = ${f.object_id}`);
      }
      if (t.features === null) await tx.setting.deleteMany({ where: { key: 'org_features' } });
      else await tx.setting.upsert({ where: { key: 'org_features' }, update: { value: t.features, updated_by: userId }, create: { key: 'org_features', value: t.features, updated_by: userId } });
    }, { timeout: 60_000 });
    this.logger.warn(`cấu trúc tuỳ biến quay lui về phiên bản #${id} bởi user ${userId}`);
    return { restored_version: id };
  }
}
