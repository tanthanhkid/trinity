import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadVisibleObject } from '../custom-object-access';
import type { FieldDef } from '../field-types';
import { RecordPresenter, type RecordView } from '../record-presenter.service';
import { RecordRefsService } from './record-refs.service';
import type { Ref, RefView } from './ref-types';

export interface RefPreview extends RefView { fields: { label: string; value: string }[] }

const MAX_FIELDS = 5;
const vnDate = (d: Date | null | undefined): string => (d ? new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10).split('-').reverse().join('/') : '—');

const pad = (n: number): string => String(n).padStart(2, '0');
/** ISO (hoặc chuỗi Date.parse được) → `dd/MM/yyyy HH:mm` giờ VN (Asia/Ho_Chi_Minh, UTC+7 không DST); không đọc được → giữ nguyên. */
export function vnDateTime(raw: string): string {
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  const d = new Date(t + 7 * 3_600_000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Một giá trị đã trình bày → chữ ngắn (xem nhanh khi rê chuột vào thẻ @). SĐT đã được presenter che theo quyền. */
export function previewText(f: FieldDef, rec: RecordView): string | null {
  const v = rec.data[f.key];
  if (v === undefined || v === null || v === '') return null;
  const rel = rec.relations[f.key];
  if (rel) return (Array.isArray(rel) ? rel : [rel]).map((r) => r.title ?? 'Không xem được').join(', ');
  if (f.type === 'select') return f.options.choices?.find((c) => c.value === v)?.label ?? String(v);
  if (f.type === 'multi_select' && Array.isArray(v)) return v.map((x) => f.options.choices?.find((c) => c.value === x)?.label ?? String(x)).join(', ');
  if (f.type === 'boolean') return v === true ? 'Có' : 'Không';
  if (f.type === 'date' && typeof v === 'string') return v.split('-').reverse().join('/');
  if (f.type === 'datetime' && typeof v === 'string') return vnDateTime(v);
  if (f.type === 'currency' && typeof v === 'number') return `${v.toLocaleString('vi-VN')} đ`;
  const s = String(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** Xem nhanh một bản ghi (rê chuột vào thẻ @): mã, tên, bảng + vài trường — chỉ khi người xem thấy được bản ghi. */
@Injectable()
export class RefPreviewService {
  constructor(private readonly prisma: PrismaService, private readonly refs: RecordRefsService, private readonly presenter: RecordPresenter) {}

  async preview(user: AuthUser, ref: Ref): Promise<RefPreview> {
    const view = (await this.refs.resolveRefs(user, [ref])).get(`${ref.type}:${ref.id}`);
    if (!view) throw new NotFoundException('Không tìm thấy bản ghi');
    return { ...view, fields: await this.fieldsOf(user, view) };
  }

  private async fieldsOf(user: AuthUser, v: RefView): Promise<RefPreview['fields']> {
    if (v.type === 'record' && v.table_key) {
      const def = await loadVisibleObject(this.prisma, user, v.table_key);
      const row = await this.prisma.customRecord.findUniqueOrThrow({ where: { id: v.id } });
      const [rec] = await this.presenter.present(def, user, [row]);
      return def.fields.filter((f) => !f.is_title && f.show_in_list && f.type !== 'long_text')
        .map((f) => ({ label: f.label, value: previewText(f, rec) })).filter((x): x is { label: string; value: string } => x.value !== null).slice(0, MAX_FIELDS);
    }
    if (v.type === 'contact') {
      const c = await this.prisma.contact.findUnique({ where: { id: v.id }, select: { created_at: true, assigned_user: { select: { full_name: true } } } });
      return [{ label: 'Phụ trách', value: c?.assigned_user?.full_name ?? '—' }, { label: 'Ngày tạo', value: vnDate(c?.created_at) }];
    }
    if (v.type === 'deal') {
      const d = await this.prisma.deal.findUnique({ where: { id: v.id }, select: { status: true, value: true } });
      return [{ label: 'Trạng thái', value: d?.status ?? '—' }, { label: 'Giá trị', value: d?.value != null ? `${Number(d.value).toLocaleString('vi-VN')} đ` : '—' }];
    }
    const t = await this.prisma.kanbanCard.findUnique({ where: { id: v.id }, select: { due_at: true, column: { select: { name: true } }, board: { select: { name: true } } } });
    return [{ label: 'Bảng', value: t?.board.name ?? '—' }, { label: 'Cột', value: t?.column.name ?? '—' }, { label: 'Hạn', value: vnDate(t?.due_at) }];
  }
}
