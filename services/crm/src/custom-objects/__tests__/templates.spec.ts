import { validateFormula } from '../field-definition';
import { normalizeOptions, normalizeValue } from '../field-values';
import { CUSTOM_OBJECT_TEMPLATES, findTemplate } from '../templates';
import { EDUCATION_CENTER_TEMPLATE } from '../templates/education-center.template';
import { KEY_REGEX, CUSTOM_ICONS, LIMITS, TITLE_TYPES, type FieldDef } from '../field-types';
import { computeFormulas } from '../record-presenter.service';

const toDefs = (obj: (typeof EDUCATION_CENTER_TEMPLATE)['objects'][number], targetIds: Record<string, number>): FieldDef[] =>
  obj.fields.map((f, i) => ({
    id: i + 1, key: f.key, label: f.label, type: f.type, required: !!f.required, is_unique: !!f.is_unique, is_title: !!f.is_title, show_in_list: true, sort_order: i,
    options: f.type === 'formula' ? normalizeOptions('formula', { expression: f.expression, format: f.format, decimals: f.decimals })
      : f.type === 'select' ? normalizeOptions('select', { choices: f.choices })
      : f.type === 'relation' ? normalizeOptions('relation', { target_object_id: targetIds[f.relation as string], multiple: f.multiple }) : {},
    help_text: f.help_text ?? null,
  }));

describe('mẫu education_center', () => {
  const tpl = EDUCATION_CENTER_TEMPLATE;
  const ids = Object.fromEntries(tpl.objects.map((o, i) => [o.key, i + 1]));

  it('đủ 6 thực thể đúng thứ tự, khoá/icon hợp lệ, trong giới hạn', () => {
    expect(tpl.objects.map((o) => o.key)).toEqual(['phu_huynh', 'hoc_sinh', 'khoa_hoc', 'hoa_don', 'ghi_danh', 'thanh_toan']);
    expect(findTemplate('education_center')).toBe(tpl);
    expect(findTemplate('khong_co')).toBeUndefined();
    expect(CUSTOM_OBJECT_TEMPLATES.map((t) => t.key)).toEqual(['education_center', 'real_estate', 'retail_service', 'clinic']);
    for (const o of tpl.objects) {
      expect(o.key).toMatch(KEY_REGEX);
      expect((CUSTOM_ICONS as readonly string[]).includes(o.icon)).toBe(true);
      expect(o.fields.length).toBeLessThanOrEqual(LIMITS.maxFieldsPerObject);
      expect(new Set(o.fields.map((f) => f.key)).size).toBe(o.fields.length);
      o.fields.forEach((f) => expect(f.key).toMatch(KEY_REGEX));
    }
  });

  it('mỗi thực thể đúng 1 trường tiêu đề thuộc kiểu cho phép; "duy nhất" không đặt trên SĐT', () => {
    for (const o of tpl.objects) {
      const titles = o.fields.filter((f) => f.is_title);
      expect(titles).toHaveLength(1);
      expect(TITLE_TYPES).toContain(titles[0].type);
      expect(o.fields.filter((f) => f.is_unique && f.type === 'phone')).toHaveLength(0);
    }
  });

  it('liên kết trỏ đúng thực thể TRONG mẫu; công thức qua parser hệ thống, tham chiếu trường có thật', () => {
    for (const o of tpl.objects) {
      for (const f of o.fields.filter((x) => x.type === 'relation')) expect(ids[f.relation as string]).toBeDefined();
      expect(() => toDefs(o, ids)).not.toThrow();
      for (const f of o.fields.filter((x) => x.type === 'formula')) expect(() => validateFormula(f.expression as string, toDefs(o, ids), f.key)).not.toThrow();
    }
  });

  it('cấu trúc mẫu: select Tình trạng / Giới tính / Phương thức / Trạng thái / Mức giá', () => {
    const f = (o: string, k: string) => tpl.objects.find((x) => x.key === o)!.fields.find((x) => x.key === k)!;
    expect(f('hoc_sinh', 'gioi_tinh').choices!.map((c) => c.label)).toEqual(['Nam', 'Nữ']);
    expect(f('hoc_sinh', 'tinh_trang_hoc').choices!.map((c) => c.label)).toEqual(['Đang học', 'Tạm nghỉ', 'Không có nhu cầu', 'Đã kết thúc']);
    expect(f('ghi_danh', 'trang_thai').choices!.map((c) => c.label)).toEqual(['Đang học', 'Hoàn thành', 'Tạm dừng', 'Đã huỷ']);
    expect(f('thanh_toan', 'phuong_thuc').choices!.map((c) => c.label)).toEqual(['Chuyển khoản', 'Tiền mặt', 'Thẻ', 'Ví điện tử']);
    expect(f('thanh_toan', 'trang_thai').choices!.map((c) => c.label)).toEqual(['Đã thanh toán', 'Chờ xác nhận', 'Chưa thanh toán', 'Hoàn tiền']);
    expect(f('hoa_don', 'muc_gia').choices!.map((c) => c.label)).toEqual(['Giá thanh toán', 'Giá giới thiệu', 'Giá nhóm']);
    expect(f('ghi_danh', 'ma_ghi_danh')).toMatchObject({ is_unique: true, required: true });
    expect(f('ghi_danh', 'hoc_sinh')).toMatchObject({ relation: 'hoc_sinh', required: true });
  });

  it('công thức gói học phí ra ĐÚNG số theo bảng giá mẫu (4 gói)', () => {
    const course = tpl.objects.find((o) => o.key === 'khoa_hoc')!;
    const defs = toDefs(course, ids);
    const expected: Record<string, [number, number, number, number]> = {
      'Gói THÁNG': [3_000_000, 2_700_000, 2_400_000, 375_000],
      'Gói QUÝ (3 tháng)': [8_550_000, 7_695_000, 6_840_000, 356_250],
      'Gói HỌC KỲ (6 tháng)': [16_200_000, 14_580_000, 12_960_000, 337_500],
      'Gói NĂM (1 cấp độ)': [30_600_000, 27_540_000, 24_480_000, 318_750],
    };
    const pk = tpl.samples('2026-10-05').filter((s) => s.object === 'khoa_hoc');
    expect(pk).toHaveLength(4);
    for (const p of pk) {
      const data = Object.fromEntries(Object.entries(p.data).map(([k, v]) => [k, normalizeValue(defs.find((d) => d.key === k)!, v)]));
      const r = computeFormulas(defs, data);
      expect([r.thanh_toan, r.gia_gioi_thieu, r.gia_nhom, r.don_gia_buoi]).toEqual(expected[String(p.data.ten_goi)]);
    }
  });

  it('Thực tế (tháng) = làm tròn 1 số lẻ từ Bắt đầu đến Kết thúc', () => {
    const enr = tpl.objects.find((o) => o.key === 'ghi_danh')!;
    const defs = toDefs(enr, ids);
    expect(computeFormulas(defs, { bat_dau: '2026-01-01', ket_thuc: '2026-04-01' }).thuc_te_thang).toBe(3);
    expect(computeFormulas(defs, { bat_dau: '2026-01-01', ket_thuc: '2026-02-16' }).thuc_te_thang).toBe(1.5);
    expect(computeFormulas(defs, { bat_dau: '2026-01-01' }).thuc_te_thang).toBeNull();
  });

  it('dữ liệu mẫu hoàn toàn GIẢ & hợp lệ theo định nghĩa trường; liên kết trỏ đúng chỉ số', () => {
    const samples = tpl.samples('2026-10-05');
    const counts: Record<string, number> = {};
    for (const s of samples) counts[s.object] = (counts[s.object] ?? 0) + 1;
    expect(counts).toEqual({ phu_huynh: 3, hoc_sinh: 4, khoa_hoc: 4, hoa_don: 3, ghi_danh: 3, thanh_toan: 3 });
    for (const s of samples) {
      const obj = tpl.objects.find((o) => o.key === s.object)!;
      const defs = toDefs(obj, ids);
      for (const [k, v] of Object.entries(s.data)) expect(() => normalizeValue(defs.find((d) => d.key === k)!, v)).not.toThrow();
      for (const [k, ref] of Object.entries(s.refs ?? {})) {
        const target = obj.fields.find((f) => f.key === k)!.relation!;
        for (const i of Array.isArray(ref) ? ref : [ref]) expect(i).toBeLessThan(counts[target]);
      }
    }
    const text = JSON.stringify(samples);
    expect(text).toMatch(/Phụ huynh Mẫu 01/);
    expect(text).toMatch(/0900000001/);
    for (const m of text.matchAll(/"sdt":"(\d+)"/g)) expect(m[1]).toMatch(/^0900000\d{3}$/);
    expect(text).not.toMatch(/@(gmail|yahoo|hotmail)\./);
  });
});
