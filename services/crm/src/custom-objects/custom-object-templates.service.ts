import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { toFieldDef } from './custom-object-access';
import { validateFormula } from './field-definition';
import { LIMITS, type FieldDef, type RecordData } from './field-types';
import { normalizeOptions, normalizeValue } from './field-values';
import { titleOf } from './record-events';
import { findTemplate, CUSTOM_OBJECT_TEMPLATES, type CustomObjectTemplate, type TemplateField, type TemplateObject } from './templates';

const LOCK_NS = 7374;

export interface ApplyTemplateResult {
  created: string[];
  existing: string[];
  sample_records: number;
}

const vnToday = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

/**
 * Áp mẫu dựng sẵn (vd "Trung tâm giáo dục"): tạo các thực thể + trường + liên kết trong MỘT transaction, có khoá để 2 lần
 * bấm song song không nhân đôi. IDEMPOTENT theo `key`: thực thể đã có (kể cả do người dùng tự tạo) được GIỮ NGUYÊN và báo ở
 * `existing`; dữ liệu mẫu (GIẢ) chỉ sinh cho thực thể MỚI tạo ở lần gọi này. Quyền: `custom_objects.manage`; kèm dữ liệu mẫu
 * cần thêm `custom_records.manage`.
 */
@Injectable()
export class CustomObjectTemplatesService {
  private readonly logger = new Logger(CustomObjectTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const live = await this.prisma.customObject.findMany({ where: { deleted_at: null }, select: { key: true } });
    const have = new Set(live.map((o) => o.key));
    return CUSTOM_OBJECT_TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      description: t.description,
      objects: t.objects.map((o) => ({ key: o.key, label: o.label_plural, applied: have.has(o.key) })),
    }));
  }

  async apply(user: AuthUser, templateKey: string, withSampleData: boolean): Promise<ApplyTemplateResult> {
    const tpl = findTemplate(templateKey);
    if (!tpl) throw new NotFoundException('Không tìm thấy mẫu này');
    if (withSampleData && !can(user.grants, 'custom_records.manage')) {
      throw new ForbiddenException('Tạo dữ liệu mẫu cần thêm quyền “Thêm/sửa dữ liệu của tính năng tuỳ biến”');
    }
    for (const o of tpl.objects) this.assertTemplateValid(o);
    const result = await this.prisma
      .$transaction((tx) => this.applyInTx(tx, user, tpl, withSampleData), { timeout: 60_000, maxWait: 10_000 })
      .catch((e: unknown) => {
        // Có người vừa tạo thực thể trùng mã giữa lúc đọc và ghi (tạo thủ công không dùng chung khoá) → báo thử lại, không 500.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Vừa có người tạo tính năng trùng mã. Hãy thử áp mẫu lại.');
        throw e;
      });
    this.logger.log(`template ${templateKey} áp bởi user ${user.userId}: tạo [${result.created}] giữ [${result.existing}] mẫu ${result.sample_records}`);
    return result;
  }

  private async applyInTx(tx: Prisma.TransactionClient, user: AuthUser, tpl: CustomObjectTemplate, withSamples: boolean): Promise<ApplyTemplateResult> {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, 1)`);
    const live = await tx.customObject.findMany({ where: { deleted_at: null }, select: { id: true, key: true, nav_order: true } });
    const ids = new Map(live.map((o) => [o.key, o.id]));
    const toCreate = tpl.objects.filter((o) => !ids.has(o.key));
    if (live.length + toCreate.length > LIMITS.maxObjects) throw new BadRequestException(`Vượt giới hạn ${LIMITS.maxObjects} tính năng tuỳ biến`);
    let order = live.reduce((m, o) => Math.max(m, o.nav_order), 0);
    for (const o of toCreate) {
      const row = await tx.customObject.create({
        data: { key: o.key, label: o.label, label_plural: o.label_plural, icon: o.icon, description: o.description, show_in_nav: true, nav_order: ++order, visible_role_ids: [], is_active: true, created_by: user.userId },
      });
      ids.set(o.key, row.id);
    }
    const defs = new Map<string, FieldDef[]>();
    for (const o of toCreate) defs.set(o.key, await this.createFields(tx, ids, o));
    let samples = 0;
    if (withSamples && toCreate.length > 0) samples = await this.seedSamples(tx, user, tpl, new Set(toCreate.map((o) => o.key)), defs);
    return { created: toCreate.map((o) => o.key), existing: tpl.objects.filter((o) => !toCreate.includes(o)).map((o) => o.key), sample_records: samples };
  }

  private async createFields(tx: Prisma.TransactionClient, ids: Map<string, number>, obj: TemplateObject): Promise<FieldDef[]> {
    const out: FieldDef[] = [];
    let sort = 0;
    for (const f of obj.fields) {
      const options = this.fieldOptions(f, ids);
      const row = await tx.customField.create({
        data: {
          object_id: ids.get(obj.key) as number, key: f.key, label: f.label, type: f.type, required: f.required ?? false, is_unique: f.is_unique ?? false,
          is_title: f.is_title ?? false, show_in_list: f.show_in_list ?? true, sort_order: (sort += 10), options: options as unknown as Prisma.InputJsonValue, help_text: f.help_text ?? null,
        },
      });
      out.push(toFieldDef(row));
    }
    return out;
  }

  private fieldOptions(f: TemplateField, ids: Map<string, number>) {
    if (f.type === 'select' || f.type === 'multi_select') return normalizeOptions(f.type, { choices: f.choices });
    if (f.type === 'formula') return normalizeOptions('formula', { expression: f.expression, format: f.format, decimals: f.decimals });
    if (f.type === 'relation') {
      if (f.relation === 'contact') return normalizeOptions('relation', { target: 'contact', multiple: f.multiple });
      const target = f.relation ? ids.get(f.relation) : undefined;
      if (!target) throw new ConflictException(`Thiếu tính năng “${f.relation}” để liên kết (mẫu cần tạo/giữ nó trước)`);
      return normalizeOptions('relation', { target_object_id: target, multiple: f.multiple });
    }
    return {};
  }

  /** Kiểm mẫu hợp lệ TRƯỚC khi ghi: đúng 1 tiêu đề, công thức qua parser hệ thống (không tham chiếu trường lạ / công thức khác). */
  private assertTemplateValid(obj: TemplateObject): void {
    if (obj.fields.filter((f) => f.is_title).length !== 1) throw new BadRequestException(`Mẫu lỗi: “${obj.key}” phải có đúng 1 trường tiêu đề`);
    const asDefs: FieldDef[] = obj.fields.map((f, i) => ({
      id: i + 1, key: f.key, label: f.label, type: f.type, required: !!f.required, is_unique: !!f.is_unique, is_title: !!f.is_title,
      show_in_list: true, sort_order: i, options: f.type === 'formula' ? { expression: f.expression } : {}, help_text: null,
    }));
    for (const f of obj.fields) if (f.type === 'formula') validateFormula(f.expression ?? '', asDefs, f.key);
  }

  /**
   * Thực thể được sinh dữ liệu mẫu: vừa MỚI tạo VÀ mọi trường liên kết BẮT BUỘC trỏ tới thực thể cũng sinh mẫu — để không tạo
   * bản ghi mẫu thiếu trường bắt buộc (sau này sửa sẽ bị báo lỗi). Duyệt theo thứ tự mẫu (đích đứng trước nguồn).
   */
  private seedableObjects(tpl: CustomObjectTemplate, created: Set<string>): Set<string> {
    const ok = new Set<string>();
    for (const o of tpl.objects) {
      if (!created.has(o.key)) continue;
      const needs = o.fields.filter((f) => f.type === 'relation' && f.required && f.relation && f.relation !== 'contact');
      if (needs.every((f) => ok.has(f.relation as string))) ok.add(o.key);
    }
    return ok;
  }

  private async seedSamples(tx: Prisma.TransactionClient, user: AuthUser, tpl: CustomObjectTemplate, created: Set<string>, defs: Map<string, FieldDef[]>): Promise<number> {
    const createdIds = new Map<string, number[]>();
    const seedable = this.seedableObjects(tpl, created);
    const objectIds = new Map((await tx.customObject.findMany({ where: { key: { in: [...created] }, deleted_at: null }, select: { id: true, key: true } })).map((o) => [o.key, o.id]));
    let n = 0;
    for (const s of tpl.samples(vnToday())) {
      if (!seedable.has(s.object)) continue;
      const fields = defs.get(s.object) as FieldDef[];
      const data: RecordData = {};
      for (const [k, v] of Object.entries(s.data)) data[k] = normalizeValue(fields.find((f) => f.key === k) as FieldDef, v);
      for (const [k, ref] of Object.entries(s.refs ?? {})) {
        const f = fields.find((x) => x.key === k);
        const targetKey = tpl.objects.find((o) => o.key === s.object)?.fields.find((x) => x.key === k)?.relation;
        const pool = targetKey ? createdIds.get(targetKey) : undefined;
        if (!f || !pool) continue;
        const picked = Array.isArray(ref) ? ref.map((i) => pool[i]).filter((x) => x !== undefined) : pool[ref];
        if (picked !== undefined && !(Array.isArray(picked) && picked.length === 0)) data[k] = picked;
      }
      const row = await tx.customRecord.create({
        data: { object_id: objectIds.get(s.object) as number, data: data as Prisma.InputJsonValue, title: titleOf({ obj: {} as never, fields }, data), owner_id: user.userId, created_by: user.userId },
      });
      createdIds.set(s.object, [...(createdIds.get(s.object) ?? []), row.id]);
      n++;
    }
    return n;
  }
}
