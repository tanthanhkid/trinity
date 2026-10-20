import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { loadObjectAccess, loadVisibleObject, type ObjectAccess } from '../../custom-objects/custom-object-access';
import {
  normalizeReportDefs, parseReportPeriod, REPORT_DEFS_KEY, REPORT_LIMITS, ReportDefError,
  type ReportDef, type ReportPeriod,
} from './report-def';
import { REPORT_PRESETS, resolvePresetReport } from './report-presets';
import { CORE_SOURCES, customSource, findField, type ReportSourceSpec, type SourceField } from './report-sources';

export interface ReportNumbers {
  count: number;
  sums: Record<string, number>;
}
export interface ReportResult extends ReportNumbers {
  report: ReportDef;
  period: { value: string; label: string };
  /** Bản ghi không có ngày (trống / sai dạng) — chỉ nằm trong kỳ "Tất cả". */
  missing_date: number;
  groups: (ReportNumbers & { key: string | null; label: string })[];
  by_month: (ReportNumbers & { month: string })[];
  fields: { date: string; sums: { key: string; label: string }[]; group: string | null };
}

const CONFIG_PERM = 'custom_objects.manage';

/** Báo cáo dùng chung (#25): đọc/ghi định nghĩa (chỉ quản trị viên) và chạy số liệu theo phạm vi quyền người xem. */
@Injectable()
export class CustomReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  canManage(user: AuthUser): boolean {
    return user.isAdmin || can(user.grants, CONFIG_PERM);
  }

  async readDefs(): Promise<ReportDef[]> {
    const row = await this.prisma.setting.findUnique({ where: { key: REPORT_DEFS_KEY }, select: { value: true } });
    if (!row) return [];
    try {
      return normalizeReportDefs(JSON.parse(row.value));
    } catch {
      return [];
    }
  }

  /** Báo cáo người xem mở được: chỉ những báo cáo có bảng nguồn họ được xem. */
  async list(user: AuthUser): Promise<{ reports: (ReportDef & { source_label: string })[]; can_manage: boolean }> {
    const defs = await this.readDefs();
    const acc = await loadObjectAccess(this.prisma, user);
    const out: (ReportDef & { source_label: string })[] = [];
    for (const d of defs) {
      const spec = await this.resolveSource(user, d.source, acc).catch(() => null);
      if (spec && (await this.scope.ownerIds(user, spec.scopePerm)) !== null) out.push({ ...d, source_label: spec.label });
    }
    return { reports: out, can_manage: this.canManage(user) };
  }

  /** Danh mục bảng + trường cho màn cấu hình (quản trị viên). */
  async sources(user: AuthUser) {
    const acc = await loadObjectAccess(this.prisma, user);
    const objs = await this.prisma.customObject.findMany({ where: { deleted_at: null }, orderBy: [{ id: 'asc' }], select: { key: true } });
    const specs: ReportSourceSpec[] = [...CORE_SOURCES];
    for (const o of objs) {
      const spec = await this.resolveSource(user, `x:${o.key}`, acc).catch(() => null);
      if (spec) specs.push(spec);
    }
    return specs.map((s) => ({ source: s.source, label: s.label, fields: s.fields.map((f) => ({ key: f.key, label: f.label, role: f.role })) }));
  }

  async save(user: AuthUser, raw: unknown): Promise<ReportDef[]> {
    let defs: ReportDef[];
    try {
      defs = normalizeReportDefs(raw);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const acc = await loadObjectAccess(this.prisma, user);
    for (const d of defs) {
      const spec = await this.resolveSource(user, d.source, acc).catch(() => null);
      if (!spec) throw new BadRequestException(`“${d.name}”: không có bảng nguồn ${d.source}`);
      this.fieldsOf(spec, d);
    }
    await this.writeDefs(user, defs);
    return defs;
  }

  /** Bộ mẫu + từng báo cáo: cài được không (bảng có chưa), đã có chưa (trùng mã). */
  async presets(user: AuthUser) {
    const have = new Set((await this.readDefs()).map((d) => d.id));
    const acc = await loadObjectAccess(this.prisma, user);
    const out = [];
    for (const p of REPORT_PRESETS) {
      const reports = [];
      for (const r of p.reports) {
        const spec = await this.firstSource(user, r.sources, acc);
        reports.push({ id: r.id, name: r.name, source_label: spec?.label ?? null, installed: have.has(r.id), installable: !!spec && !have.has(r.id) });
      }
      out.push({ key: p.key, name: p.name, description: p.description, reports });
    }
    return out;
  }

  /**
   * Cài một bộ mẫu: thêm những báo cáo có bảng nguồn và chưa có mã trùng; trường lấy theo danh mục thật của bảng.
   * Báo cáo đã có giữ nguyên (cài lại không ghi đè chỉnh sửa của quản trị viên).
   */
  async installPreset(user: AuthUser, key: string): Promise<{ installed: string[]; skipped: { id: string; reason: string }[] }> {
    const preset = REPORT_PRESETS.find((p) => p.key === key);
    if (!preset) throw new NotFoundException('Không có bộ mẫu này');
    const defs = await this.readDefs();
    const have = new Set(defs.map((d) => d.id));
    const acc = await loadObjectAccess(this.prisma, user);
    const installed: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const r of preset.reports) {
      if (have.has(r.id)) { skipped.push({ id: r.id, reason: 'đã có' }); continue; }
      const spec = await this.firstSource(user, r.sources, acc);
      if (!spec) { skipped.push({ id: r.id, reason: 'chưa có bảng' }); continue; }
      if (defs.length >= REPORT_LIMITS.maxReports) { skipped.push({ id: r.id, reason: 'đủ số báo cáo tối đa' }); continue; }
      defs.push(resolvePresetReport(r, preset.key, spec.source, (k, role) => !!findField(spec, k, role)));
      have.add(r.id);
      installed.push(r.id);
    }
    if (installed.length) await this.writeDefs(user, defs);
    return { installed, skipped };
  }

  private async firstSource(user: AuthUser, sources: string[], acc: ObjectAccess): Promise<ReportSourceSpec | null> {
    for (const s of sources) {
      const spec = await this.resolveSource(user, s, acc).catch(() => null);
      if (spec) return spec;
    }
    return null;
  }

  private async writeDefs(user: AuthUser, defs: ReportDef[]) {
    await this.prisma.setting.upsert({
      where: { key: REPORT_DEFS_KEY },
      create: { key: REPORT_DEFS_KEY, value: JSON.stringify(defs), updated_by: user.userId },
      update: { value: JSON.stringify(defs), updated_by: user.userId },
    });
  }

  async run(user: AuthUser, id: string, periodRaw: string | undefined): Promise<ReportResult> {
    const def = (await this.readDefs()).find((d) => d.id === id);
    if (!def) throw new NotFoundException('Không tìm thấy báo cáo');
    const spec = await this.resolveSource(user, def.source);
    const owners = await this.scope.ownerIds(user, spec.scopePerm);
    if (owners === null) throw new NotFoundException('Không tìm thấy báo cáo');
    const period = parseReportPeriod(periodRaw);
    const { date, sums, group } = this.fieldsOf(spec, def);
    const res = await this.aggregate(spec, owners, period, date, sums, group);
    return {
      report: def,
      period: { value: periodRaw && period.kind === 'range' ? periodRaw : period.kind === 'all' ? 'all' : 'this_month', label: period.kind === 'all' ? 'Tất cả' : period.label },
      ...res,
      groups: group ? await this.labelGroups(user, group, res.groups) : [],
      fields: { date: date.label, sums: sums.map((s) => ({ key: s.key, label: s.label })), group: group?.label ?? null },
    };
  }

  /** Đối chiếu khoá trường trong định nghĩa với danh mục của bảng nguồn (sai ⇒ 400 khi lưu, 404 khi chạy). */
  private fieldsOf(spec: ReportSourceSpec, d: ReportDef): { date: SourceField; sums: SourceField[]; group: SourceField | null } {
    const date = findField(spec, d.date_field, 'date');
    if (!date) throw new BadRequestException(`“${d.name}”: “${d.date_field}” không phải trường ngày của ${spec.label}`);
    const sums = d.sum_fields.map((k) => {
      const f = findField(spec, k, 'number');
      if (!f) throw new BadRequestException(`“${d.name}”: “${k}” không phải cột số của ${spec.label}`);
      return f;
    });
    const group = d.group_by ? findField(spec, d.group_by, 'group') : null;
    if (d.group_by && !group) throw new BadRequestException(`“${d.name}”: không nhóm được theo “${d.group_by}”`);
    return { date, sums, group: group ?? null };
  }

  private async resolveSource(user: AuthUser, source: string, acc?: ObjectAccess): Promise<ReportSourceSpec> {
    const core = CORE_SOURCES.find((s) => s.source === source);
    if (core) return core;
    if (!source.startsWith('x:')) throw new NotFoundException('Không tìm thấy bảng nguồn');
    return customSource(await loadVisibleObject(this.prisma, user, source.slice(2), acc));
  }

  /** Một lượt cho tổng, một lượt theo nhóm, một lượt theo tháng — cùng điều kiện nền + phạm vi + kỳ. */
  private async aggregate(spec: ReportSourceSpec, owners: number[] | 'all', period: ReportPeriod, date: SourceField, sums: SourceField[], group: SourceField | null) {
    const scopeSql = owners === 'all'
      ? Prisma.sql`TRUE`
      : Prisma.sql`(${Prisma.join(spec.ownerCols.map((c) => Prisma.sql`${Prisma.raw(c)} = ANY(${owners}::int[])`), ' OR ')})`;
    const d = date.expr;
    const inPeriod = period.kind === 'all' ? Prisma.sql`TRUE` : Prisma.sql`${d} >= ${period.from}::date AND ${d} < ${period.to}::date`;
    const where = Prisma.sql`${spec.base} AND ${scopeSql} AND ${inPeriod}`;
    const sumCols = sums.length
      ? Prisma.sql`, ${Prisma.join(sums.map((s, i) => Prisma.sql`COALESCE(sum(${s.expr}), 0)::float8 AS ${Prisma.raw(`s${i}`)}`))}`
      : Prisma.empty;
    const table = Prisma.raw(spec.table);
    type Row = Record<string, unknown> & { n: number };
    const nums = (r: Row): ReportNumbers => ({ count: Number(r.n), sums: Object.fromEntries(sums.map((s, i) => [s.key, Number(r[`s${i}`] ?? 0)])) });

    const [total] = await this.prisma.$queryRaw<(Row & { missing: number })[]>(Prisma.sql`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE ${d} IS NULL)::int AS missing ${sumCols} FROM ${table} WHERE ${where}`);
    const groups = group
      ? await this.prisma.$queryRaw<(Row & { k: string | null })[]>(Prisma.sql`
          SELECT ${group.expr} AS k, count(*)::int AS n ${sumCols} FROM ${table} WHERE ${where}
          GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${REPORT_LIMITS.maxGroups}`)
      : [];
    const months = await this.prisma.$queryRaw<(Row & { m: string })[]>(Prisma.sql`
      SELECT to_char(${d}, 'YYYY-MM') AS m, count(*)::int AS n ${sumCols} FROM ${table} WHERE ${where} AND ${d} IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT ${REPORT_LIMITS.maxMonths}`);
    return {
      ...nums(total),
      missing_date: Number(total.missing),
      groups: groups.map((g) => ({ key: g.k, ...nums(g) })),
      by_month: months.reverse().map((m) => ({ month: m.m, ...nums(m) })),
    };
  }

  /**
   * Mã nhóm → nhãn (lựa chọn, người dùng, tuỳ chọn hệ thống, khách, bản ghi liên kết). Không có ⇒ "(Trống)".
   * Khách / bản ghi liên kết NGOÀI phạm vi xem của người xem chỉ hiện mã `#id` (như ô liên kết ở danh sách).
   */
  private async labelGroups(user: AuthUser, group: SourceField, rows: (ReportNumbers & { key: string | null })[]) {
    const ids = rows.map((r) => Number(r.key)).filter((n) => Number.isInteger(n) && n > 0);
    const l = group.labels ?? { kind: 'raw' };
    const inScope = async (perm: 'contacts.view' | 'custom_records.view', cols: [string, string]) => {
      const owners = await this.scope.ownerIds(user, perm);
      if (owners === null) return null;
      return owners === 'all' ? {} : { OR: cols.map((c) => ({ [c]: { in: owners } })) };
    };
    let names = new Map<string, string>();
    if (l.kind === 'map') names = new Map(Object.entries(l.labels));
    else if (ids.length && l.kind === 'user') names = idMap(await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, full_name: true } }), 'full_name');
    else if (ids.length && l.kind === 'option') names = idMap(await this.prisma.settingOption.findMany({ where: { id: { in: ids } }, select: { id: true, label: true } }), 'label');
    else if (ids.length && l.kind === 'contact') {
      const sc = await inScope('contacts.view', ['assigned_to', 'created_by_id']);
      if (sc) names = idMap(await this.prisma.contact.findMany({ where: { AND: [{ id: { in: ids }, deleted_at: null }, sc] }, select: { id: true, full_name: true } }), 'full_name');
    } else if (ids.length && l.kind === 'record') {
      const sc = await inScope('custom_records.view', ['owner_id', 'created_by']);
      if (sc) names = idMap(await this.prisma.customRecord.findMany({ where: { AND: [{ id: { in: ids }, object_id: l.objectId, deleted_at: null }, sc] }, select: { id: true, title: true } }), 'title');
    }
    const fallback = (k: string) => (l.kind === 'map' || l.kind === 'raw' ? k : `#${k}`);
    return rows.map((r) => ({ ...r, label: r.key == null || r.key === '' ? '(Trống)' : names.get(r.key) ?? fallback(r.key) }));
  }
}

function idMap<T extends { id: number }>(rows: T[], k: keyof T): Map<string, string> {
  return new Map(rows.map((r) => [String(r.id), String(r[k] ?? `#${r.id}`)]));
}

export { ReportDefError };
