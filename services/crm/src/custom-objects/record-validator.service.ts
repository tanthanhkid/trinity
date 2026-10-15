import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { scopeWhere, ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { isObjectVisible, loadObjectAccess, type ObjectDef } from './custom-object-access';
import { isEmptyValue, normalizeValue, ValueError } from './field-values';
import { LIMITS, type FieldDef, type RecordData } from './field-types';
import { idsOf } from './record-presenter.service';
import { RecordRefsService } from './refs/record-refs.service';

export interface ValidatedRecord {
  data: RecordData;
  /** Khoá trường có giá trị đổi so với bản cũ (để phát sự kiện + kiểm trùng). */
  changed: string[];
}

type PrismaLike = Pick<PrismaService, '$queryRaw'>;

/**
 * Kiểm dữ liệu bản ghi theo định nghĩa trường (kiểu, bắt buộc, lựa chọn, liên kết tồn tại + TRONG PHẠM VI người ghi,
 * kích thước) và trả dữ liệu đã chuẩn hoá. Lỗi gom theo trường → 400 `{message, errors:{khoá: thông báo}}`.
 */
@Injectable()
export class RecordValidator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    @Optional() private readonly refs?: RecordRefsService,
  ) {}

  async validate(def: ObjectDef, user: AuthUser, input: Record<string, unknown>, existing: RecordData | null): Promise<ValidatedRecord> {
    // Không-prototype: khoá do client gửi (`__proto__`, `constructor`) không được làm hỏng/ẩn lỗi.
    const errors: Record<string, string> = Object.create(null);
    const byKey = new Map(def.fields.map((f) => [f.key, f]));
    const merged: RecordData = { ...(existing ?? {}) };
    const changed: string[] = [];
    for (const [key, raw] of Object.entries(input)) {
      const f = byKey.get(key);
      if (!f) { errors[key] = 'Trường không tồn tại'; continue; }
      try {
        const v = normalizeValue(f, raw);
        const same = JSON.stringify(v ?? null) === JSON.stringify(merged[key] ?? null);
        if (v === null) delete merged[key]; else merged[key] = v;
        if (!same) changed.push(key);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        errors[key] = e.message;
      }
    }
    for (const f of def.fields) {
      if (f.required && f.type !== 'formula' && isEmptyValue(merged[f.key]) && !errors[f.key]) errors[f.key] = `“${f.label}” là bắt buộc`;
    }
    await this.checkRelations(def, user, merged, changed, errors);
    await this.checkLinks(def, user, merged, changed, errors);
    if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > LIMITS.maxDataBytes) {
      errors._data = `Dữ liệu một bản ghi tối đa ${LIMITS.maxDataBytes / 1024} KB`;
    }
    if (Object.keys(errors).length > 0) throw new BadRequestException({ statusCode: 400, message: 'Dữ liệu không hợp lệ', errors: { ...errors } });
    return { data: merged, changed };
  }

  /** Kiểm trùng cho trường “duy nhất” — gọi TRONG transaction đã giữ khoá thực thể. */
  async assertUnique(db: PrismaLike, def: ObjectDef, data: RecordData, changed: string[], excludeId: number | null): Promise<void> {
    const errors: Record<string, string> = {};
    for (const f of def.fields) {
      const v = data[f.key];
      if (!f.is_unique || v === undefined || v === null) continue;
      if (excludeId !== null && !changed.includes(f.key)) continue;
      const cond = typeof v === 'string'
        ? Prisma.sql`lower(data ->> ${f.key}) = ${v.toLowerCase()}`
        : Prisma.sql`(data -> ${f.key}) = ${JSON.stringify(v)}::jsonb`;
      const rows = await db.$queryRaw<{ x: number }[]>(
        Prisma.sql`SELECT 1 AS x FROM custom_records WHERE object_id = ${def.obj.id} AND deleted_at IS NULL AND id <> ${excludeId ?? 0} AND ${cond} LIMIT 1`,
      );
      if (rows.length > 0) errors[f.key] = `“${f.label}” đã tồn tại, không được trùng`;
    }
    if (Object.keys(errors).length > 0) throw new BadRequestException({ statusCode: 400, message: 'Dữ liệu không hợp lệ', errors });
  }

  private async checkRelations(def: ObjectDef, user: AuthUser, data: RecordData, changed: string[], errors: Record<string, string>): Promise<void> {
    for (const f of def.fields) {
      if ((f.type !== 'relation' && f.type !== 'user') || !changed.includes(f.key) || errors[f.key]) continue;
      const ids = idsOf(data[f.key]);
      if (ids.length === 0) continue;
      const ok = await this.countAccessible(f, user, ids);
      if (ok !== ids.length) errors[f.key] = `“${f.label}”: có mục không tồn tại hoặc bạn không có quyền chọn`;
    }
  }

  /**
   * Trường "Liên kết": mã/`loại:id` → tham chiếu `loại:id` CHỈ khi người ghi thấy được bản ghi đích (không gắn được thứ mình không xem,
   * không dò được mã có tồn tại hay không — mọi lỗi chung một câu). Mục chưa đổi thì giữ nguyên (đích có thể đã bị xoá: vẫn lưu, hiện "Không xem được").
   */
  private async checkLinks(def: ObjectDef, user: AuthUser, data: RecordData, changed: string[], errors: Record<string, string>): Promise<void> {
    const fields = def.fields.filter((f) => f.type === 'link' && changed.includes(f.key) && !errors[f.key] && Array.isArray(data[f.key]));
    if (fields.length === 0) return;
    if (!this.refs) throw new Error('RecordRefsService chưa được nối vào RecordValidator');
    const acc = await this.refs.access(user);
    for (const f of fields) {
      const { refs, missing } = await this.refs.resolveTokens(user, data[f.key] as string[], acc);
      if (missing.length) errors[f.key] = `“${f.label}”: không tìm thấy ${missing.slice(0, 5).join(', ')} (hoặc bạn không có quyền xem)`;
      else if (refs.length) data[f.key] = refs.map((r) => r.ref);
      else delete data[f.key];
    }
  }

  /** Số id (không trùng) thật sự tồn tại VÀ người ghi được phép tham chiếu. */
  private async countAccessible(f: FieldDef, user: AuthUser, ids: number[]): Promise<number> {
    if (f.type === 'user') {
      // Chỉ chọn được nhân viên TRONG phạm vi xem của người ghi (cùng nguồn với danh sách chọn), không dò thư mục theo id.
      const owners = await this.scope.ownerIds(user, 'custom_records.view');
      if (owners === null) return 0;
      const inScope = owners === 'all' ? ids : ids.filter((i) => i === user.userId || owners.includes(i));
      return this.prisma.user.count({ where: { id: { in: inScope }, status: 'active', deleted_at: null } });
    }
    if (f.options.target === 'contact') {
      const owners = await this.scope.ownerIds(user, 'contacts.view');
      if (owners === null) return 0;
      return this.prisma.contact.count({ where: { AND: [{ id: { in: ids }, deleted_at: null }, scopeWhere(owners, ['assigned_to', 'created_by_id'])] } });
    }
    const targetId = f.options.target_object_id as number;
    const [access, target, owners] = await Promise.all([
      loadObjectAccess(this.prisma, user),
      this.prisma.customObject.findFirst({ where: { id: targetId, deleted_at: null } }),
      this.scope.ownerIds(user, 'custom_records.view'),
    ]);
    if (!target || owners === null || !isObjectVisible(target, access)) return 0;
    return this.prisma.customRecord.count({
      where: { AND: [{ object_id: targetId, deleted_at: null, id: { in: ids } }, scopeWhere(owners, ['owner_id', 'created_by'])] },
    });
  }
}
