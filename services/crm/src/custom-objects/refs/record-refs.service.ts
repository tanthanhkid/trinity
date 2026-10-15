import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { escapeLike } from '../record-query';
import { CORE_CODE_PREFIXES, parseCode, type ParsedCode } from '../record-codes';
import { foldVi, SQL_FOLD_FROM, SQL_FOLD_TO } from './fold-vi';
import { findContacts, findDeals, findRecords, findTasks, loadRefAccess, type RefAccess } from './ref-sources';
import { parseRef, refKey, type Ref, type RefType, type RefView } from './ref-types';

const CODE_LIKE = /^[A-Za-z]{1,4}\d{0,9}$/;
export const SUGGEST_MAX = 20;
/** Số ứng viên tối đa lấy theo tên (khách/deal/việc) trước khi lọc quyền xem. */
const NAME_CANDIDATES = 200;

/**
 * Tra cứu bản ghi theo mã / tên / id trên MỌI bảng cho gắn thẻ @ — luôn theo quyền xem của người hỏi (ref-sources).
 * Gợi ý dùng chỉ mục: mã (`varchar_pattern_ops`, LIKE 'HS%'), tên so KHÔNG DẤU (`translate(lower(title))`, quét có LIMIT); khớp giữa tên (từ thứ 2) quét có LIMIT.
 */
@Injectable()
export class RecordRefsService {
  constructor(private readonly prisma: PrismaService, private readonly scope: ScopeService) {}

  access(user: AuthUser): Promise<RefAccess> {
    return loadRefAccess(this.prisma, this.scope, user);
  }

  /** `@HS` → bản ghi có mã bắt đầu HS; `@Nguyễn` → tên bắt đầu/chứa từ "Nguyễn"; rỗng → bản ghi mới nhất. Mã khớp xếp trước. */
  async suggest(user: AuthUser, raw: string, limit = 8): Promise<RefView[]> {
    const q = raw.trim().replace(/^@/, '').slice(0, 60);
    const n = Math.min(Math.max(limit, 1), SUGGEST_MAX);
    const acc = await this.access(user);
    const byCode = CODE_LIKE.test(q) ? await this.searchCode(acc, q.toUpperCase(), n) : [];
    const byName = q.length >= (CODE_LIKE.test(q) ? 2 : 1) || q === '' ? await this.searchName(acc, q, n) : [];
    const seen = new Set<string>();
    return [...byCode, ...byName].filter((v) => !seen.has(v.ref) && seen.add(v.ref)).slice(0, n);
  }

  private async searchCode(acc: RefAccess, q: string, n: number): Promise<RefView[]> {
    const like = `${escapeLike(q)}%`;
    const core = (Object.entries(CORE_CODE_PREFIXES) as [RefType, string][]).filter(([, p]) => p.startsWith(q.slice(0, 2)) || q.startsWith(p));
    const coreWhere = { code: { startsWith: q } };
    const [recs, ...cores] = await Promise.all([
      findRecords(this.prisma, acc, Prisma.sql`code LIKE ${like} ESCAPE '\\'`, n, Prisma.sql`code_seq ASC, id ASC`),
      ...core.map(([t]) => (t === 'contact' ? findContacts(this.prisma, acc, coreWhere, n) : t === 'deal' ? findDeals(this.prisma, acc, coreWhere, n) : findTasks(this.prisma, acc, coreWhere, n))),
    ]);
    return [...recs, ...cores.flat()].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? '', 'en', { numeric: true }));
  }

  private async searchName(acc: RefAccess, q: string, n: number): Promise<RefView[]> {
    if (q === '') return findRecords(this.prisma, acc, Prisma.sql`TRUE`, n, Prisma.sql`updated_at DESC`);
    const lower = escapeLike(foldVi(q));
    const fold = (col: string) => Prisma.sql`translate(lower(${Prisma.raw(col)}), ${SQL_FOLD_FROM}, ${SQL_FOLD_TO})`;
    const likeAny = (col: string) => Prisma.sql`(${fold(col)} LIKE ${`${lower}%`} ESCAPE '\\' OR ${fold(col)} LIKE ${`% ${lower}%`} ESCAPE '\\')`;
    const ids = async (table: string, col: string): Promise<number[]> => {
      const rows = await this.prisma.$queryRaw<{ id: number }[]>(Prisma.sql`SELECT id FROM ${Prisma.raw(table)} WHERE ${fold(col)} LIKE ${`%${lower}%`} ESCAPE '\\' ORDER BY id DESC LIMIT ${NAME_CANDIDATES}`);
      return rows.map((r) => r.id);
    };
    const [cIds, dIds, tIds] = await Promise.all([q.length >= 2 ? ids('contacts', 'full_name') : [], ids('deals', 'title'), ids('kanban_cards', 'title')]);
    const parts = await Promise.all([
      findRecords(this.prisma, acc, likeAny('title'), n, Prisma.sql`(${fold('title')} LIKE ${`${lower}%`} ESCAPE '\\') DESC, id DESC`),
      findContacts(this.prisma, acc, { id: { in: cIds } }, n),
      findDeals(this.prisma, acc, { id: { in: dIds } }, n),
      findTasks(this.prisma, acc, { id: { in: tIds } }, n),
    ]);
    return parts.flat();
  }

  /** Mã → bản ghi người xem thấy (mã CŨ qua alias tiền tố vẫn ra). Khoá map = mã chuẩn người gửi lên. */
  async resolveCodes(user: AuthUser, codes: string[], acc?: RefAccess): Promise<Map<string, RefView>> {
    const parsed = [...new Map(codes.map(parseCode).filter((c): c is ParsedCode => !!c).map((c) => [c.code, c])).values()].slice(0, 100);
    const out = new Map<string, RefView>();
    if (parsed.length === 0) return out;
    const a = acc ?? (await this.access(user));
    const core = (p: string) => parsed.filter((c) => c.prefix === p).map((c) => c.code);
    const pairs: Prisma.Sql[] = [];
    const want = new Map<string, string>();
    for (const c of parsed) {
      for (const o of a.objects.values()) {
        if (o.code_prefix !== c.prefix && !o.code_prefix_aliases.includes(c.prefix)) continue;
        pairs.push(Prisma.sql`(object_id = ${o.id} AND code_seq = ${c.seq})`);
        want.set(`${o.id}:${c.seq}`, c.code);
      }
    }
    const [recs, contacts, deals, tasks] = await Promise.all([
      pairs.length ? this.recordsWithSeq(a, Prisma.join(pairs, ' OR '), pairs.length) : Promise.resolve([]),
      core(CORE_CODE_PREFIXES.contact).length ? findContacts(this.prisma, a, { code: { in: core(CORE_CODE_PREFIXES.contact) } }, 100) : Promise.resolve([]),
      core(CORE_CODE_PREFIXES.deal).length ? findDeals(this.prisma, a, { code: { in: core(CORE_CODE_PREFIXES.deal) } }, 100) : Promise.resolve([]),
      core(CORE_CODE_PREFIXES.task).length ? findTasks(this.prisma, a, { code: { in: core(CORE_CODE_PREFIXES.task) } }, 100) : Promise.resolve([]),
    ]);
    for (const r of recs) out.set(want.get(r.key) ?? r.view.code ?? '', r.view);
    for (const v of [...contacts, ...deals, ...tasks]) if (v.code) out.set(v.code, v);
    return out;
  }

  private async recordsWithSeq(acc: RefAccess, cond: Prisma.Sql, n: number): Promise<{ key: string; view: RefView }[]> {
    const views = await findRecords(this.prisma, acc, Prisma.sql`(${cond})`, n);
    if (views.length === 0) return [];
    const seqs = await this.prisma.customRecord.findMany({ where: { id: { in: views.map((v) => v.id) } }, select: { id: true, object_id: true, code_seq: true } });
    const byId = new Map(seqs.map((s) => [s.id, `${s.object_id}:${s.code_seq}`]));
    return views.map((v) => ({ key: byId.get(v.id) ?? '', view: v }));
  }

  /** `loại:id` → bản ghi người xem thấy (thiếu trong map = đã xoá hoặc ngoài phạm vi). */
  async resolveRefs(user: AuthUser, refs: Ref[], acc?: RefAccess): Promise<Map<string, RefView>> {
    const out = new Map<string, RefView>();
    if (refs.length === 0) return out;
    const a = acc ?? (await this.access(user));
    const ids = (t: RefType) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))].slice(0, 500);
    const [recs, contacts, deals, tasks] = await Promise.all([
      ids('record').length ? findRecords(this.prisma, a, Prisma.sql`id = ANY(${ids('record')}::int[])`, 500) : Promise.resolve([]),
      ids('contact').length ? findContacts(this.prisma, a, { id: { in: ids('contact') } }, 500) : Promise.resolve([]),
      ids('deal').length ? findDeals(this.prisma, a, { id: { in: ids('deal') } }, 500) : Promise.resolve([]),
      ids('task').length ? findTasks(this.prisma, a, { id: { in: ids('task') } }, 500) : Promise.resolve([]),
    ]);
    for (const v of [...recs, ...contacts, ...deals, ...tasks]) out.set(refKey(v), v);
    return out;
  }

  /** Chuỗi người dùng/AI gửi (mã `HS001` hoặc `record:12`) → tham chiếu người GHI được thấy; mục không ra → `missing`. */
  async resolveTokens(user: AuthUser, tokens: string[], acc?: RefAccess): Promise<{ refs: RefView[]; missing: string[] }> {
    const a = acc ?? (await this.access(user));
    const asRefs = tokens.map(parseRef);
    const [byRef, byCode] = await Promise.all([
      this.resolveRefs(user, asRefs.filter((r): r is Ref => !!r), a),
      this.resolveCodes(user, tokens.filter((_, i) => !asRefs[i]), a),
    ]);
    const refs: RefView[] = [];
    const missing: string[] = [];
    tokens.forEach((t, i) => {
      const r = asRefs[i];
      const v = r ? byRef.get(refKey(r)) : byCode.get(parseCode(t)?.code ?? '');
      if (v) { if (!refs.some((x) => x.ref === v.ref)) refs.push(v); } else missing.push(t);
    });
    return { refs, missing };
  }
}
