import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { assertInScope, scopeWhere, ScopeService, type AuthUser } from '@trinity/rbac-nest';
import {
  isObjectVisible, loadObjectAccess, loadVisibleObject, toFieldDef, type ObjectDef,
} from './custom-object-access';
import { LIMITS } from './field-types';
import { RecordPresenter, type RecordRow, type RecordView } from './record-presenter.service';
import {
  buildFilters, buildSort, cursorSql, decodeCursor, encodeCursor, escapeLike, orderSql, scopeSql, whereSql, type SortSpec,
} from './record-query';
import type { ListCustomRecordsQueryDto, LookupQueryDto } from './dto/custom-record.dto';

export interface RowQuery {
  q?: string;
  limit: number;
  cursor?: string;
  /** Bỏ qua bấy nhiêu dòng đầu (phân trang theo số trang). Bỏ qua khi có `cursor`. */
  offset?: number;
  sort?: string;
  dir: 'asc' | 'desc';
  filter?: string;
  withTotal: boolean;
  /** `q` khớp thêm mọi trường chữ (text, long_text) của bảng, ngoài tiêu đề và mã. */
  qInText?: boolean;
}

/** Trang n (từ 1) → số dòng bỏ qua; `cursor` thắng `page`. */
export function pageOffset(q: { page?: number; limit?: number; cursor?: string }): number {
  if (q.cursor || !q.page || q.page < 2) return 0;
  return (q.page - 1) * (q.limit ?? LIMITS.defaultListLimit);
}

type SortedRow = RecordRow & { sort_v: string | null };

/** Ô tìm: khớp tiêu đề (chứa) HOẶC mã (bắt đầu bằng — "HS0" ra HS001…HS009). */
export function codeOrTitleSql(q: string): Prisma.Sql {
  const like = escapeLike(q);
  return Prisma.sql`(title ILIKE ${`%${like}%`} ESCAPE '\\' OR code LIKE ${`${like.toUpperCase()}%`} ESCAPE '\\')`;
}

/** Kiểu trường chữ được ô tìm quét thêm khi `qInText` (không gồm phone/email: SĐT luôn bị che với AI). */
export const TEXT_SEARCH_TYPES: readonly string[] = ['text', 'long_text'];

/** Ô tìm mở rộng: tiêu đề / mã như `codeOrTitleSql`, HOẶC chứa trong một trường chữ của bảng. */
export function codeTitleOrTextSql(q: string, fieldKeys: readonly string[]): Prisma.Sql {
  if (fieldKeys.length === 0) return codeOrTitleSql(q);
  const like = `%${escapeLike(q)}%`;
  const parts = fieldKeys.map((k) => Prisma.sql`(data->>${k}) ILIKE ${like} ESCAPE '\\'`);
  return Prisma.sql`(${codeOrTitleSql(q)} OR ${Prisma.join(parts, ' OR ')})`;
}

/** Đọc danh sách / tra cứu / liên kết ngược của bản ghi tuỳ biến. Phạm vi = `custom_records.view` (owner_id ∪ created_by). */
@Injectable()
export class CustomRecordsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly presenter: RecordPresenter,
  ) {}

  async list(user: AuthUser, key: string, q: ListCustomRecordsQueryDto, opts: { qInText?: boolean } = {}) {
    const def = await loadVisibleObject(this.prisma, user, key);
    const owners = await this.scope.ownerIds(user, 'custom_records.view');
    if (owners === null) return { items: [], next_cursor: null, total: 0 };
    const res = await this.queryRows(def, [scopeSql(owners)], {
      q: q.q, limit: q.limit ?? LIMITS.defaultListLimit, cursor: q.cursor, offset: pageOffset(q), sort: q.sort, dir: q.dir ?? 'desc', filter: q.filter, withTotal: !q.cursor || q.page !== undefined, qInText: opts.qInText,
    });
    return { items: await this.presenter.present(def, user, res.rows), next_cursor: res.next, total: res.total };
  }

  /** Truy vấn lõi — dùng chung cho danh sách và xuất CSV. `extra` PHẢI chứa điều kiện phạm vi. */
  async queryRows(def: ObjectDef, extra: Prisma.Sql[], o: RowQuery): Promise<{ rows: RecordRow[]; next: string | null; total: number | null }> {
    const sort = buildSort(def, o.sort);
    const base: Prisma.Sql[] = [Prisma.sql`object_id = ${def.obj.id}`, Prisma.sql`deleted_at IS NULL`, ...extra, ...buildFilters(def, o.filter)];
    const q = o.q?.trim();
    if (q) base.push(o.qInText ? codeTitleOrTextSql(q, def.fields.filter((f) => TEXT_SEARCH_TYPES.includes(f.type)).map((f) => f.key)) : codeOrTitleSql(q));
    const withCursor = o.cursor ? [...base, cursorSql(sort, o.dir, decodeCursor(o.cursor))] : base;
    const sortV = sort.kind === 'id' ? Prisma.sql`NULL::text` : Prisma.sql`(${sort.expr})::text`;
    const rows = await this.prisma.$queryRaw<SortedRow[]>(Prisma.sql`
      SELECT id, data, title, code, owner_id, created_by, created_at, updated_at, ${sortV} AS sort_v
      FROM custom_records WHERE ${whereSql(withCursor)} ${orderSql(sort, o.dir)} LIMIT ${o.limit + 1} OFFSET ${o.cursor ? 0 : (o.offset ?? 0)}`);
    const more = rows.length > o.limit;
    const page = more ? rows.slice(0, o.limit) : rows;
    const last = page[page.length - 1];
    const next = more && last ? encodeCursor({ v: this.cursorValue(sort, last), id: last.id }) : null;
    const total = o.withTotal ? await this.count(base) : null;
    return { rows: page, next, total };
  }

  private cursorValue(sort: SortSpec, last: SortedRow): string | null {
    return sort.kind === 'id' ? null : last.sort_v;
  }

  private async count(parts: Prisma.Sql[]): Promise<number> {
    const r = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM custom_records WHERE ${whereSql(parts)}`);
    return r[0]?.n ?? 0;
  }

  async getOne(user: AuthUser, key: string, id: number): Promise<RecordView> {
    const def = await loadVisibleObject(this.prisma, user, key);
    const row = await this.prisma.customRecord.findFirst({ where: { id, object_id: def.obj.id, deleted_at: null } });
    if (!row) throw new NotFoundException('Không tìm thấy bản ghi');
    await assertInScope(this.scope, user, 'custom_records.view', [row.owner_id, row.created_by]);
    return (await this.presenter.present(def, user, [row]))[0];
  }

  /** Combobox liên kết: chỉ trả bản ghi TRONG phạm vi xem, chỉ `{id, title}`. */
  async lookup(user: AuthUser, key: string, q: LookupQueryDto) {
    const def = await loadVisibleObject(this.prisma, user, key);
    const owners = await this.scope.ownerIds(user, 'custom_records.view');
    if (owners === null) return [];
    const term = q.q?.trim();
    const rows = await this.prisma.customRecord.findMany({
      where: { AND: [{ object_id: def.obj.id, deleted_at: null, ...(term ? { OR: [{ title: { contains: term, mode: 'insensitive' as const } }, { code: { startsWith: term.toUpperCase() } }] } : {}) }, scopeWhere(owners, ['owner_id', 'created_by'])] },
      orderBy: { id: 'desc' },
      take: Math.min(q.limit ?? LIMITS.lookupLimit, 50),
      select: { id: true, title: true, code: true },
    });
    return rows.map((r) => ({ id: r.id, code: r.code, title: r.title ?? `${def.obj.label} #${r.id}` }));
  }

  /** Người chọn: user active TRONG phạm vi (xem hoặc sửa); chỉ trả tên + id, không email/SĐT. */
  async lookupUsers(user: AuthUser, q: LookupQueryDto) {
    const perm = q.for === 'manage' ? 'custom_records.manage' : 'custom_records.view';
    const owners = (await this.scope.ownerIds(user, perm)) ?? [user.userId];
    const term = q.q?.trim();
    const idScope = owners === 'all' ? {} : { id: { in: [...new Set([...owners, user.userId])] } };
    const rows = await this.prisma.user.findMany({
      where: { AND: [{ status: 'active', deleted_at: null }, idScope, term ? { OR: [{ full_name: { contains: term, mode: 'insensitive' as const } }, { email: { contains: term, mode: 'insensitive' as const } }] } : {}] },
      orderBy: { full_name: 'asc' },
      take: Math.min(q.limit ?? 50, 50),
      select: { id: true, full_name: true, email: true },
    });
    return rows.map((u) => ({ id: u.id, title: u.full_name || u.email }));
  }

  /** Khách để chọn trong trường liên kết → Danh bạ: chỉ trong phạm vi `contacts.view`, tìm theo TÊN (không theo SĐT — chống dò). */
  async lookupContacts(user: AuthUser, q: LookupQueryDto) {
    const owners = await this.scope.ownerIds(user, 'contacts.view');
    const term = q.q?.trim() ?? '';
    if (owners === null || term.length < 2) return [];
    const rows = await this.prisma.contact.findMany({
      where: { AND: [{ deleted_at: null, full_name: { contains: term, mode: 'insensitive' as const } }, scopeWhere(owners, ['assigned_to', 'created_by_id'])] },
      orderBy: { id: 'desc' },
      take: Math.min(q.limit ?? LIMITS.lookupLimit, 50),
      select: { id: true, full_name: true },
    });
    return rows.map((c) => ({ id: c.id, title: c.full_name || `Khách #${c.id}` }));
  }

  /** Bản ghi của thực thể KHÁC đang trỏ tới bản ghi này (vd Phụ huynh → Học sinh của họ), chỉ phần người xem được. */
  async related(user: AuthUser, key: string, id: number) {
    const def = await loadVisibleObject(this.prisma, user, key);
    const row = await this.prisma.customRecord.findFirst({ where: { id, object_id: def.obj.id, deleted_at: null }, select: { owner_id: true, created_by: true } });
    if (!row) throw new NotFoundException('Không tìm thấy bản ghi');
    await assertInScope(this.scope, user, 'custom_records.view', [row.owner_id, row.created_by]);
    const [owners, access, refs] = await Promise.all([
      this.scope.ownerIds(user, 'custom_records.view'),
      loadObjectAccess(this.prisma, user),
      this.prisma.customField.findMany({
        where: { deleted_at: null, type: 'relation', object: { deleted_at: null }, options: { path: ['target_object_id'], equals: def.obj.id } },
        include: { object: true },
        orderBy: { id: 'asc' },
        take: LIMITS.maxRelatedGroups,
      }),
    ]);
    if (owners === null) return [];
    const groups: { object: { key: string; label_plural: string }; field: { key: string; label: string }; total: number; items: { id: number; code: string | null; title: string }[] }[] = [];
    for (const ref of refs) {
      if (!isObjectVisible(ref.object, access)) continue;
      const f = toFieldDef(ref);
      const where = [Prisma.sql`object_id = ${ref.object_id}`, Prisma.sql`deleted_at IS NULL`, scopeSql(owners), Prisma.sql`(data -> ${f.key}) @> ${JSON.stringify(id)}::jsonb`];
      const [items, total] = await Promise.all([
        this.prisma.$queryRaw<{ id: number; code: string | null; title: string | null }[]>(Prisma.sql`SELECT id, code, title FROM custom_records WHERE ${whereSql(where)} ORDER BY id DESC LIMIT ${LIMITS.relatedPerGroup}`),
        this.count(where),
      ]);
      if (total === 0) continue;
      groups.push({
        object: { key: ref.object.key, label_plural: ref.object.label_plural },
        field: { key: f.key, label: f.label },
        total,
        items: items.map((r) => ({ id: r.id, code: r.code, title: r.title ?? `${ref.object.label} #${r.id}` })),
      });
    }
    return groups;
  }
}
