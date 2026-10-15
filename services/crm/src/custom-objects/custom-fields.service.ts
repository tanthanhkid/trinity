import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadVisibleObject, toFieldDef, type ObjectDef } from './custom-object-access';
import {
  assertFlagsAllowed, buildOptions, fieldHasData, formulasReferencing, hasDuplicates, refKindOf, typesCompatible, usedChoiceValues,
  validateFormula,
} from './field-definition';
import { isFieldType, KEY_REGEX, LIMITS, TITLE_TYPES, type FieldDef, type FieldType } from './field-types';
import { formulaInput, slugifyKey } from './field-values';
import { evaluateFormula, parseFormula } from './formula/formula-parser';
import type { CreateCustomFieldDto, FormulaPreviewDto, ReorderCustomFieldsDto, UpdateCustomFieldDto } from './dto/custom-field.dto';

const LOCK_NS = 7373;

/** Định nghĩa trường của thực thể tuỳ biến. Quyền `custom_objects.manage` do controller gác. */
@Injectable()
export class CustomFieldsService {
  private readonly logger = new Logger(CustomFieldsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(objectKey: string, dto: CreateCustomFieldDto, user: AuthUser): Promise<FieldDef> {
    const def = await loadVisibleObject(this.prisma, user, objectKey);
    const type = this.asType(dto.type);
    const key = dto.key ?? slugifyKey(dto.label);
    if (!KEY_REGEX.test(key)) throw new BadRequestException('Mã trường chỉ gồm a-z, 0-9, _ , bắt đầu bằng chữ');
    // `constructor`, `valueOf`, `toString`… đọc ra HÀM kế thừa từ Object.prototype → làm sai kiểm bắt buộc/duy nhất/tiêu đề.
    if (key in Object.prototype) throw new BadRequestException(`Mã trường “${key}” là từ khoá của hệ thống, hãy chọn mã khác`);
    if (!dto.label.trim()) throw new BadRequestException('Tên trường không được để trống');
    if (def.fields.length >= LIMITS.maxFieldsPerObject) throw new BadRequestException(`Mỗi tính năng tối đa ${LIMITS.maxFieldsPerObject} trường`);
    if (def.fields.some((f) => f.key === key)) throw new ConflictException(`Mã trường “${key}” đã tồn tại`);
    if (await fieldHasData(this.prisma, def.obj.id, key)) {
      throw new ConflictException(`Mã “${key}” từng được dùng và vẫn còn dữ liệu cũ trong các bản ghi. Hãy chọn mã trường khác.`);
    }
    const options = buildOptions(type, dto.options, def.fields);
    await this.checkRelationTarget(type, options, def.obj.id);
    const autoTitle = dto.is_title === undefined && !def.fields.some((f) => f.is_title) && TITLE_TYPES.includes(type);
    const flags = { required: dto.required ?? false, is_unique: dto.is_unique ?? false, is_title: dto.is_title ?? autoTitle };
    assertFlagsAllowed(type, flags);
    const sort = (def.fields.reduce((m, f) => Math.max(m, f.sort_order), 0)) + 10;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, ${def.obj.id}::int)`);
      if (flags.is_title) await tx.customField.updateMany({ where: { object_id: def.obj.id, is_title: true, deleted_at: null }, data: { is_title: false } });
      const created = await tx.customField.create({
        data: {
          object_id: def.obj.id, key, label: dto.label.trim(), type, ...flags,
          show_in_list: dto.show_in_list ?? true, sort_order: sort,
          options: options as unknown as Prisma.InputJsonValue, help_text: dto.help_text?.trim() || null,
        },
      });
      if (flags.is_title) await this.rebuildTitles(tx, def.obj.id, key);
      return created;
    }).catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(`Mã trường “${key}” đã tồn tại`);
      throw e;
    });
    this.logger.log(`custom_field ${objectKey}.${key} (${type}) tạo bởi user ${user.userId}`);
    return toFieldDef(row);
  }

  async update(objectKey: string, fieldKey: string, dto: UpdateCustomFieldDto, user: AuthUser): Promise<FieldDef> {
    const def = await loadVisibleObject(this.prisma, user, objectKey);
    const cur = this.findField(def, fieldKey);
    if (dto.label !== undefined && !dto.label.trim()) throw new BadRequestException('Tên trường không được để trống');
    const type = dto.type !== undefined ? this.asType(dto.type) : cur.type;
    const typeChanged = type !== cur.type;
    const hasData = typeChanged || dto.options !== undefined ? await fieldHasData(this.prisma, def.obj.id, fieldKey) : false;
    if (typeChanged) await this.checkTypeChange(def, cur, type, hasData);
    const options = dto.options !== undefined || typeChanged ? buildOptions(type, dto.options ?? (typeChanged ? {} : cur.options), def.fields, fieldKey) : cur.options;
    await this.checkOptionsChange(def, cur, type, options, hasData);
    const flags = {
      required: type === 'formula' ? false : dto.required ?? cur.required,
      is_unique: type === 'formula' ? false : dto.is_unique ?? cur.is_unique,
      is_title: dto.is_title ?? cur.is_title,
    };
    if (cur.is_title && dto.is_title === false) throw new ConflictException('Phải chọn trường khác làm tiêu đề trước khi bỏ tiêu đề của trường này');
    assertFlagsAllowed(type, flags);
    if (flags.is_unique && !cur.is_unique && (await hasDuplicates(this.prisma, def.obj.id, fieldKey))) {
      throw new ConflictException('Đang có bản ghi trùng giá trị ở trường này nên chưa bật được “duy nhất”. Hãy xử lý trùng trước.');
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, ${def.obj.id}::int)`);
      if (flags.is_title && !cur.is_title) await tx.customField.updateMany({ where: { object_id: def.obj.id, is_title: true, deleted_at: null }, data: { is_title: false } });
      const updated = await tx.customField.update({
        where: { id: cur.id },
        data: {
          label: dto.label !== undefined ? dto.label.trim() : undefined,
          type, ...flags,
          show_in_list: dto.show_in_list,
          options: options as unknown as Prisma.InputJsonValue,
          help_text: dto.help_text === undefined ? undefined : dto.help_text?.trim() || null,
        },
      });
      if (flags.is_title && !cur.is_title) await this.rebuildTitles(tx, def.obj.id, fieldKey);
      return updated;
    });
    this.logger.log(`custom_field ${objectKey}.${fieldKey} sửa bởi user ${user.userId}`);
    return toFieldDef(row);
  }

  async remove(objectKey: string, fieldKey: string, user: AuthUser) {
    const def = await loadVisibleObject(this.prisma, user, objectKey);
    const cur = this.findField(def, fieldKey);
    if (cur.is_title) throw new ConflictException('Đây là trường tiêu đề. Hãy chọn trường khác làm tiêu đề trước khi xoá.');
    const used = formulasReferencing(def.fields, fieldKey);
    if (used.length > 0) throw new ConflictException(`Không xoá được: trường công thức “${used.map((f) => f.label).join('”, “')}” đang dùng trường này`);
    await this.prisma.customField.update({ where: { id: cur.id }, data: { deleted_at: new Date() } });
    this.logger.warn(`custom_field ${objectKey}.${fieldKey} xoá mềm bởi user ${user.userId} (dữ liệu cũ vẫn nằm trong bản ghi)`);
    return { ok: true };
  }

  async reorder(objectKey: string, dto: ReorderCustomFieldsDto, user: AuthUser) {
    const def = await loadVisibleObject(this.prisma, user, objectKey);
    const have = def.fields.map((f) => f.key).sort();
    const want = [...new Set(dto.keys)].sort();
    if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
      throw new BadRequestException('Danh sách thứ tự phải gồm đúng và đủ các trường hiện có');
    }
    const idByKey = new Map(def.fields.map((f) => [f.key, f.id]));
    await this.prisma.$transaction(
      [...new Set(dto.keys)].map((k, i) => this.prisma.customField.update({ where: { id: idByKey.get(k) as number }, data: { sort_order: (i + 1) * 10 } })),
    );
    return { ok: true };
  }

  /** Xem trước công thức: kiểm cú pháp/kiểu theo các trường thật của thực thể + tính với giá trị thử. */
  async previewFormula(dto: FormulaPreviewDto, user: AuthUser) {
    const def = await loadVisibleObject(this.prisma, user, dto.object_key);
    try {
      validateFormula(dto.expression, def.fields, dto.editing_key);
    } catch (e) {
      return { ok: false as const, error: e instanceof BadRequestException ? String((e.getResponse() as { message?: string }).message ?? e.message) : 'Công thức không hợp lệ' };
    }
    const ast = parseFormula(dto.expression);
    const sample = dto.sample ?? {};
    const result = evaluateFormula(ast, (k) => {
      const f = def.fields.find((x) => x.key === k);
      return f ? formulaInput(f.type, sample[k]) : null;
    });
    return { ok: true as const, result };
  }

  private findField(def: ObjectDef, key: string): FieldDef {
    const f = def.fields.find((x) => x.key === key);
    if (!f) throw new NotFoundException('Không tìm thấy trường này');
    return f;
  }

  private asType(t: string): FieldType {
    if (!isFieldType(t)) throw new BadRequestException('Kiểu trường không hợp lệ');
    return t;
  }

  private async checkRelationTarget(type: FieldType, options: FieldDef['options'], selfObjectId: number): Promise<void> {
    if (type !== 'relation' || options.target === 'contact') return;
    const id = options.target_object_id as number;
    if (id === selfObjectId) return;
    const t = await this.prisma.customObject.findFirst({ where: { id, deleted_at: null }, select: { id: true } });
    if (!t) throw new BadRequestException('Thực thể đích của trường liên kết không tồn tại');
  }

  private async checkTypeChange(def: ObjectDef, cur: FieldDef, next: FieldType, hasData: boolean): Promise<void> {
    if (hasData && cur.type === 'long_text' && next === 'text') {
      const rows = await this.prisma.$queryRaw<{ n: number | null }[]>(
        Prisma.sql`SELECT max(length(data ->> ${cur.key}))::int AS n FROM custom_records WHERE object_id = ${def.obj.id} AND deleted_at IS NULL`,
      );
      if ((rows[0]?.n ?? 0) > LIMITS.maxText) throw new ConflictException(`Có bản ghi dài hơn ${LIMITS.maxText} ký tự nên chưa đổi sang “văn bản ngắn” được`);
    }
    if (hasData && !typesCompatible(cur.type, next)) {
      throw new ConflictException(`Trường đã có dữ liệu nên không đổi từ “${cur.type}” sang “${next}” được. Hãy tạo trường mới rồi chuyển dữ liệu.`);
    }
    const used = formulasReferencing(def.fields, cur.key);
    if (used.length > 0 && refKindOf(next) !== refKindOf(cur.type)) {
      throw new ConflictException(`Công thức “${used.map((f) => f.label).join('”, “')}” đang dùng trường này nên chưa đổi sang kiểu khác được`);
    }
    if (cur.type === 'formula') throw new ConflictException('Không đổi kiểu của trường công thức; hãy tạo trường mới');
  }

  private async checkOptionsChange(def: ObjectDef, cur: FieldDef, type: FieldType, next: FieldDef['options'], hasData: boolean): Promise<void> {
    if (type === 'select' || type === 'multi_select') {
      if (cur.type !== type) return;
      const kept = new Set((next.choices ?? []).map((c) => c.value));
      const removed = (cur.options.choices ?? []).map((c) => c.value).filter((v) => !kept.has(v));
      const inUse = await usedChoiceValues(this.prisma, def.obj.id, cur.key, type, removed);
      if (inUse.length > 0) throw new ConflictException(`Không bỏ được lựa chọn đang có bản ghi dùng: ${inUse.slice(0, 5).join(', ')}`);
    }
    if (type === 'relation' && cur.type === 'relation' && hasData) {
      const same = cur.options.target === next.target && cur.options.target_object_id === next.target_object_id;
      const multi = Boolean(cur.options.multiple) === Boolean(next.multiple);
      if (!same || !multi) throw new ConflictException('Trường liên kết đã có dữ liệu nên không đổi nơi trỏ tới / chế độ chọn nhiều được');
    }
    if (type === 'relation') await this.checkRelationTarget(type, next, def.obj.id);
  }

  /** Cập nhật cache tiêu đề của MỌI bản ghi sau khi đổi trường tiêu đề (1 câu lệnh). */
  private async rebuildTitles(tx: Prisma.TransactionClient, objectId: number, fieldKey: string): Promise<void> {
    await tx.$executeRaw(
      Prisma.sql`UPDATE custom_records SET title = NULLIF(left(data ->> ${fieldKey}, ${LIMITS.maxTitle}::int), '') WHERE object_id = ${objectId}`,
    );
  }
}
