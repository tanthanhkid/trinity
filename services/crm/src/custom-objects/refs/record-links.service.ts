import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import type { ObjectDef } from '../custom-object-access';
import type { RecordData } from '../field-types';
import { RecordRefsService } from './record-refs.service';
import { extractMentionCodes, parseRef, type Ref, type RefView } from './ref-types';

type Tx = Prisma.TransactionClient | PrismaService;
export const BACKLINKS_MAX = 50;

export interface Backlink { source: RefView; fields: string[] }

/** Nhãn cho trường văn bản của màn LÕI (nguồn không phải bản ghi tuỳ biến): `description` + bình luận (`comment:<id>`) của công việc, ghi chú của khách. */
export function coreFieldLabel(field: string): string {
  if (field === 'description') return 'Mô tả';
  if (field === 'reminder_notes') return 'Ghi chú nhắc';
  if (field.startsWith('note:')) return 'Ghi chú';
  if (field.startsWith('comment:')) return 'Bình luận';
  return field;
}

/** Trường sinh liên kết: ô chữ dài (thẻ @ trong văn bản) + trường kiểu "Liên kết". */
export function linkingFields(def: ObjectDef): ObjectDef['fields'] {
  return def.fields.filter((f) => f.type === 'long_text' || f.type === 'link');
}

/**
 * Liên kết có cấu trúc giữa bản ghi (bảng `record_links`, không ràng buộc): ghi lại cạnh (nguồn, trường) → đích mỗi lần lưu, và
 * truy ngược "Được nhắc tới ở". Thẻ @ chỉ thành liên kết khi NGƯỜI GHI thấy được bản ghi đích (không gắn được thứ mình không).
 */
@Injectable()
export class RecordLinksService {
  private readonly logger = new Logger(RecordLinksService.name);

  constructor(private readonly prisma: PrismaService, private readonly refs: RecordRefsService) {}

  /**
   * Thẻ @ trong ô chữ của màn LÕI (mô tả công việc, ghi chú khách): ghi lại cạnh `source` (trường `field`) → các bản ghi được nhắc
   * mà NGƯỜI GHI thấy được; text rỗng/null xoá cạnh cũ. Không làm hỏng thao tác lưu chính: lỗi chỉ ghi log (cạnh sẽ khớp lại ở lần lưu sau).
   */
  async syncMentions(source: Ref, field: string, text: string | null | undefined, user: AuthUser): Promise<void> {
    try {
      const codes = text ? extractMentionCodes(text) : [];
      const found = codes.length ? await this.refs.resolveCodes(user, codes) : new Map<string, RefView>();
      const targets = [...found.values()].map((v) => ({ type: v.type, id: v.id }) as Ref);
      await this.sync(this.prisma, source, new Map([[field, targets]]), user.userId);
    } catch (e) {
      this.logger.warn(`syncMentions ${source.type}:${source.id}/${field} lỗi: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Đích của từng trường liên kết trong `data` (chỉ các trường `keys`). Văn bản: mã @ người ghi thấy được; Liên kết: giá trị đã kiểm. */
  async targetsFor(def: ObjectDef, user: AuthUser, data: RecordData, keys?: string[]): Promise<Map<string, Ref[]>> {
    const out = new Map<string, Ref[]>();
    const fields = linkingFields(def).filter((f) => !keys || keys.includes(f.key));
    const codes = new Set<string>();
    for (const f of fields) if (f.type === 'long_text' && typeof data[f.key] === 'string') extractMentionCodes(data[f.key] as string).forEach((c) => codes.add(c));
    const byCode = codes.size ? await this.refs.resolveCodes(user, [...codes]) : new Map<string, RefView>();
    for (const f of fields) {
      const v = data[f.key];
      if (f.type === 'link') out.set(f.key, (Array.isArray(v) ? v : []).map(parseRef).filter((r): r is Ref => !!r));
      else out.set(f.key, typeof v === 'string' ? extractMentionCodes(v).map((c) => byCode.get(c)).filter((x): x is RefView => !!x).map((x) => ({ type: x.type, id: x.id })) : []);
    }
    return out;
  }

  /** Ghi lại cạnh của MỘT nguồn theo từng trường (xoá cạnh cũ của trường đó, thêm cạnh hiện tại). Gọi trong transaction ghi bản ghi. */
  async sync(tx: Tx, source: Ref, targets: Map<string, Ref[]>, userId: number | null): Promise<void> {
    for (const [field, list] of targets) {
      await tx.recordLink.deleteMany({ where: { source_type: source.type, source_id: source.id, source_field: field } });
      const uniq = [...new Map(list.filter((t) => !(t.type === source.type && t.id === source.id)).map((t) => [`${t.type}:${t.id}`, t])).values()];
      if (uniq.length) {
        await tx.recordLink.createMany({
          data: uniq.map((t) => ({ source_type: source.type, source_id: source.id, source_field: field, target_type: t.type, target_id: t.id, created_by: userId })),
          skipDuplicates: true,
        });
      }
    }
  }

  /** "Được nhắc tới ở": bản ghi đang gắn thẻ / liên kết tới `target`, CHỈ những nguồn người xem thấy được (+ đích phải thấy được, không thì 404). */
  async backlinks(user: AuthUser, target: Ref): Promise<Backlink[]> {
    const acc = await this.refs.access(user);
    const self = await this.refs.resolveRefs(user, [target], acc);
    if (self.size === 0) throw new NotFoundException('Không tìm thấy bản ghi');
    const rows = await this.prisma.recordLink.findMany({
      where: { target_type: target.type, target_id: target.id },
      orderBy: { id: 'desc' }, take: 500, select: { source_type: true, source_id: true, source_field: true },
    });
    const sources = await this.refs.resolveRefs(user, rows.map((r) => ({ type: r.source_type, id: r.source_id }) as Ref), acc);
    const labels = await this.fieldLabels(rows.filter((r) => r.source_type === 'record').map((r) => r.source_id));
    const out = new Map<string, Backlink>();
    for (const r of rows) {
      const src = sources.get(`${r.source_type}:${r.source_id}`);
      if (!src) continue;
      const b = out.get(src.ref) ?? { source: src, fields: [] };
      const label = r.source_type === 'record' ? (labels.get(`${r.source_id}:${r.source_field}`) ?? r.source_field) : coreFieldLabel(r.source_field);
      if (!b.fields.includes(label)) b.fields.push(label);
      out.set(src.ref, b);
    }
    return [...out.values()].slice(0, BACKLINKS_MAX);
  }

  private async fieldLabels(recordIds: number[]): Promise<Map<string, string>> {
    if (recordIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ rid: number; key: string; label: string }[]>(Prisma.sql`
      SELECT r.id AS rid, f.key, f.label FROM custom_records r JOIN custom_fields f ON f.object_id = r.object_id AND f.deleted_at IS NULL
      WHERE r.id = ANY(${[...new Set(recordIds)]}::int[]) AND f.type IN ('long_text', 'link')`);
    return new Map(rows.map((r) => [`${r.rid}:${r.key}`, r.label]));
  }
}
