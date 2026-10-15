import { ForbiddenException } from '@nestjs/common';
import { CustomObjectTemplatesService } from '../custom-object-templates.service';
import { validateFormula } from '../field-definition';
import { normalizeOptions, normalizeValue } from '../field-values';
import { CUSTOM_ICONS, KEY_REGEX, LIMITS, TITLE_TYPES, type FieldDef } from '../field-types';
import { CUSTOM_OBJECT_TEMPLATES, findTemplate, type CustomObjectTemplate } from '../templates';
import { computeFormulas } from '../record-presenter.service';

const NEW = ['real_estate', 'retail_service', 'clinic'];
const templates = NEW.map((k) => findTemplate(k) as CustomObjectTemplate);

const toDefs = (tpl: CustomObjectTemplate, objKey: string): FieldDef[] => {
  const ids = Object.fromEntries(tpl.objects.map((o, i) => [o.key, i + 1]));
  return tpl.objects.find((o) => o.key === objKey)!.fields.map((f, i) => ({
    id: i + 1, key: f.key, label: f.label, type: f.type, required: !!f.required, is_unique: !!f.is_unique, is_title: !!f.is_title, show_in_list: true, sort_order: i,
    options: f.type === 'formula' ? normalizeOptions('formula', { expression: f.expression, format: f.format, decimals: f.decimals })
      : f.type === 'select' ? normalizeOptions('select', { choices: f.choices })
      : f.type === 'relation' ? (f.relation === 'contact' ? normalizeOptions('relation', { target: 'contact' }) : normalizeOptions('relation', { target_object_id: ids[f.relation as string], multiple: f.multiple })) : {},
    help_text: f.help_text ?? null,
  }));
};

describe('mẫu ngành mới', () => {
  it('đăng ký đủ, khoá mẫu và khoá thực thể không trùng nhau giữa các mẫu', () => {
    for (const k of NEW) expect(findTemplate(k)).toBeDefined();
    const all = CUSTOM_OBJECT_TEMPLATES.flatMap((t) => t.objects.map((o) => o.key));
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(CUSTOM_OBJECT_TEMPLATES.map((t) => t.key)).size).toBe(CUSTOM_OBJECT_TEMPLATES.length);
  });

  it.each(templates.map((t) => [t.key, t] as const))('%s: cấu trúc hợp lệ (khoá, icon, tiêu đề, liên kết, công thức)', (_k, tpl) => {
    const keys = tpl.objects.map((o) => o.key);
    for (const o of tpl.objects) {
      expect(o.key).toMatch(KEY_REGEX);
      expect((CUSTOM_ICONS as readonly string[]).includes(o.icon)).toBe(true);
      expect(o.fields.length).toBeLessThanOrEqual(LIMITS.maxFieldsPerObject);
      expect(new Set(o.fields.map((f) => f.key)).size).toBe(o.fields.length);
      const titles = o.fields.filter((f) => f.is_title);
      expect(titles).toHaveLength(1);
      expect(TITLE_TYPES).toContain(titles[0].type);
      expect(o.fields.filter((f) => f.is_unique && f.type === 'phone')).toHaveLength(0);
      const defs = toDefs(tpl, o.key);
      for (const f of o.fields) {
        expect(f.key).toMatch(KEY_REGEX);
        if (f.type === 'relation') expect(f.relation === 'contact' || keys.includes(f.relation as string)).toBe(true);
        if (f.type === 'formula') expect(() => validateFormula(f.expression as string, defs, f.key)).not.toThrow();
      }
    }
  });

  it.each(templates.map((t) => [t.key, t] as const))('%s: dữ liệu mẫu GIẢ, hợp lệ, liên kết đúng chỉ số, ≥1 bản ghi mỗi bảng', (_k, tpl) => {
    const samples = tpl.samples('2026-10-07');
    const counts: Record<string, number> = {};
    for (const s of samples) counts[s.object] = (counts[s.object] ?? 0) + 1;
    for (const o of tpl.objects) expect(counts[o.key]).toBeGreaterThan(0);
    for (const s of samples) {
      const obj = tpl.objects.find((o) => o.key === s.object)!;
      const defs = toDefs(tpl, s.object);
      for (const [k, v] of Object.entries(s.data)) expect(() => normalizeValue(defs.find((d) => d.key === k)!, v)).not.toThrow();
      for (const f of obj.fields.filter((x) => x.required && x.type !== 'formula' && x.type !== 'relation')) expect(s.data[f.key]).toBeDefined();
      for (const [k, ref] of Object.entries(s.refs ?? {})) {
        const target = obj.fields.find((f) => f.key === k)!.relation!;
        for (const i of Array.isArray(ref) ? ref : [ref]) expect(i).toBeLessThan(counts[target]);
      }
    }
    const text = JSON.stringify(samples);
    expect(text).toMatch(/Mẫu \d\d|MAU/);
    expect(text).not.toMatch(/@(gmail|yahoo|hotmail)\./);
    expect(text).not.toMatch(/"(sdt|phone)"/);
  });

  it('công thức tính đúng số', () => {
    const re = findTemplate('real_estate')!;
    expect(computeFormulas(toDefs(re, 'bds_san_pham'), { gia_ban: 3_250_000_000, dien_tich: 65 }).gia_m2).toBe(50_000_000);
    expect(computeFormulas(toDefs(re, 'bds_giu_cho'), { gia_ban: 7_800_000_000, ty_le_coc: 10 }).tien_coc).toBe(780_000_000);
    const rt = findTemplate('retail_service')!;
    expect(computeFormulas(toDefs(rt, 'bl_don_hang'), { so_luong: 3, don_gia: 600_000, giam_gia: 10 }).thanh_tien).toBe(1_620_000);
    expect(computeFormulas(toDefs(rt, 'bl_san_pham'), { gia_ban: 250_000, gia_von: 150_000 }).loi_nhuan).toBe(100_000);
    const cl = findTemplate('clinic')!;
    expect(computeFormulas(toDefs(cl, 'pk_dieu_tri'), { chi_phi_thu_thuat: 500_000, chi_phi_thuoc: 120_000 }).tong_chi_phi).toBe(620_000);
  });
});

/** Prisma giả trong bộ nhớ vừa đủ cho `apply`: cài, cài lại (giữ nguyên), gỡ (soft delete) rồi cài lại. */
function fakePrisma() {
  const objects: { id: number; key: string; nav_order: number; deleted_at: Date | null }[] = [];
  const fields: { object_id: number; key: string; type: string; options: unknown }[] = [];
  const records: { object_id: number; data: Record<string, unknown> }[] = [];
  let seq = 0;
  const tx = {
    $executeRaw: jest.fn(),
    customObject: {
      findMany: jest.fn(async (a: { where: { key?: { in: string[] } } }) => objects.filter((o) => !o.deleted_at && (!a.where.key || a.where.key.in.includes(o.key)))),
      create: jest.fn(async ({ data }: { data: { key: string; nav_order: number } }) => { const r = { id: ++seq, key: data.key, nav_order: data.nav_order, deleted_at: null }; objects.push(r); return r; }),
    },
    customField: {
      create: jest.fn(async ({ data }: { data: { object_id: number; key: string; label: string; type: string; required: boolean; is_unique: boolean; is_title: boolean; show_in_list: boolean; sort_order: number; options: unknown; help_text: string | null } }) => {
        fields.push(data);
        return { id: fields.length, ...data, deleted_at: null, created_at: new Date(), updated_at: new Date() };
      }),
    },
    customRecord: { create: jest.fn(async ({ data }: { data: { object_id: number; data: Record<string, unknown> } }) => { records.push(data); return { id: records.length }; }) },
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)), customObject: tx.customObject };
  return { prisma, objects, fields, records };
}

describe('cài / gỡ mẫu ngành qua CustomObjectTemplatesService (UI + MCP dùng chung)', () => {
  const admin = { userId: 1, grants: { 'custom_objects.manage': true, 'custom_records.manage': true } } as never;

  it.each(NEW)('%s: cài tạo đủ bảng + trường + bản ghi mẫu; cài lại giữ nguyên; gỡ rồi cài lại được', async (key) => {
    const tpl = findTemplate(key)!;
    const f = fakePrisma();
    const svc = new CustomObjectTemplatesService(f.prisma as never);
    const r1 = await svc.apply(admin, key, true);
    expect(r1.created).toEqual(tpl.objects.map((o) => o.key));
    expect(r1.existing).toEqual([]);
    expect(f.fields.length).toBe(tpl.objects.reduce((n, o) => n + o.fields.length, 0));
    expect(r1.sample_records).toBe(tpl.samples('2026-10-07').length);

    const r2 = await svc.apply(admin, key, true);
    expect(r2.created).toEqual([]);
    expect(r2.existing).toHaveLength(tpl.objects.length);
    expect(r2.sample_records).toBe(0);

    f.objects.forEach((o) => (o.deleted_at = new Date())); // gỡ (xoá mềm)
    const r3 = await svc.apply(admin, key, false);
    expect(r3.created).toHaveLength(tpl.objects.length);
    expect(r3.sample_records).toBe(0);
  });

  it('dữ liệu mẫu cần quyền ghi dữ liệu tuỳ biến', async () => {
    const svc = new CustomObjectTemplatesService(fakePrisma().prisma as never);
    await expect(svc.apply({ userId: 2, grants: { 'custom_objects.manage': true } } as never, 'clinic', true)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
