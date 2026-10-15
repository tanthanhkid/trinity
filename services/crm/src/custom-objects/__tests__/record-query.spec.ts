import { BadRequestException } from '@nestjs/common';
import type { ObjectDef } from '../custom-object-access';
import type { FieldDef } from '../field-types';
import { pageOffset } from '../custom-records-list.service';
import { buildFilters, buildSort, choiceValues, cursorSql, decodeCursor, encodeCursor, escapeLike, orderSql, pruneStaleFilter, scopeSql } from '../record-query';

const field = (key: string, type: FieldDef['type']): FieldDef => ({ id: 1, key, label: key, type, required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 0, options: {}, help_text: null });
const def = { obj: { id: 1 }, fields: [field('diem', 'number'), field('tt', 'select'), field('sdt', 'phone'), field('ten', 'text'), field('ghi_chu', 'long_text'), field('ph', 'relation'), field('ngay', 'date'), field('xong', 'boolean')] } as unknown as ObjectDef;

describe('record-query', () => {
  it('buildSort: chỉ id / updated_at / title / field:<kiểu cho phép>', () => {
    expect(buildSort(def, undefined).kind).toBe('id');
    expect(buildSort(def, 'updated_at').kind).toBe('ts');
    expect(buildSort(def, 'title').kind).toBe('text');
    expect(buildSort(def, 'field:diem').kind).toBe('num');
    expect(buildSort(def, 'field:tt').kind).toBe('text');
    for (const bad of ['field:sdt', 'field:ghi_chu', 'field:ph', 'field:khong_co', 'created_at', 'id desc', "field:diem'--", 'field:']) {
      expect(() => buildSort(def, bad)).toThrow(BadRequestException);
    }
  });

  it('khoá trường đi qua THAM SỐ, không nằm trong chuỗi SQL', () => {
    const spec = buildSort(def, 'field:diem');
    const sql = orderSql(spec, 'asc');
    expect(sql.sql).not.toContain('diem');
    expect(sql.values).toContain('diem');
    const cur = cursorSql(spec, 'desc', { v: '5', id: 9 });
    expect(cur.sql).not.toContain('diem');
    expect(cur.values).toEqual(expect.arrayContaining(['diem', '5', 9]));
  });

  it('buildFilters: từ chối trường không lọc được (phone/text/long_text), khoá lạ, JSON hỏng, quá nhiều khoá', () => {
    expect(buildFilters(def, undefined)).toEqual([]);
    expect(buildFilters(def, JSON.stringify({ tt: 'a', diem: { min: 1, max: 2 }, ngay: { from: '2025-01-01' }, xong: true, ph: [1, 2] }))).toHaveLength(6);
    for (const raw of [
      '{"sdt":"09"}', '{"ten":"x"}', '{"ghi_chu":"x"}', '{"khong":1}', '{"x\') OR 1=1 --":1}', '[1]', '"s"', '{bad',
      JSON.stringify(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 1]))),
      '{"diem":{"min":"1 OR 1=1"}}', '{"tt":"a\\u0000b"}', '{"ngay":{"from":"2025-13-99x"}}', '{"xong":"true"}', '{"ph":["x"]}',
    ]) expect(() => buildFilters(def, raw)).toThrow(BadRequestException);
  });

  it('buildFilters datetime: ngày thuần theo ngày VN (+07:00); `to` gồm cả ngày đó', () => {
    const d = { obj: { id: 1 }, fields: [field('luc', 'datetime')] } as unknown as ObjectDef;
    const [from, to] = buildFilters(d, JSON.stringify({ luc: { from: '2026-03-10', to: '2026-03-10' } }));
    expect(from.values).toEqual(['luc', '2026-03-09T17:00:00.000Z']);
    expect(to.values).toEqual(['luc', '2026-03-10T17:00:00.000Z']);
    expect(to.sql).toContain('<');
    expect(() => buildFilters(d, JSON.stringify({ luc: { from: '2026-02-30' } }))).toThrow(BadRequestException);
  });

  it('cursor: mã hoá/giải mã, từ chối rác', () => {
    expect(decodeCursor(encodeCursor({ v: '5', id: 9 }))).toEqual({ v: '5', id: 9 });
    expect(decodeCursor(encodeCursor({ v: null, id: 1 }))).toEqual({ v: null, id: 1 });
    for (const bad of ['x', Buffer.from('{"id":"1","v":null}').toString('base64url'), Buffer.from('{"id":1,"v":5}').toString('base64url'), Buffer.from('null').toString('base64url')]) {
      expect(() => decodeCursor(bad)).toThrow(BadRequestException);
    }
  });

  it('cursorSql: giá trị trong con trỏ phải đúng kiểu ép (chống 500 từ ::numeric/::timestamptz)', () => {
    const num = buildSort(def, 'field:diem');
    expect(() => cursorSql(num, 'asc', { v: 'abc', id: 1 })).toThrow(BadRequestException);
    expect(() => cursorSql(num, 'asc', { v: '1e5; DROP', id: 1 })).toThrow(BadRequestException);
    expect(() => cursorSql(num, 'asc', { v: '-12.5', id: 1 })).not.toThrow();
    expect(() => cursorSql(buildSort(def, 'updated_at'), 'asc', { v: 'khong phai ngay', id: 1 })).toThrow(BadRequestException);
    expect(() => cursorSql(buildSort(def, 'updated_at'), 'asc', { v: '2025-01-01 10:00:00+00', id: 1 })).not.toThrow();
    expect(() => cursorSql(buildSort(def, 'updated_at'), 'asc', { v: '2026-02-30 10:00:00+00', id: 1 })).toThrow(BadRequestException);
    expect(() => cursorSql(buildSort(def, 'updated_at'), 'asc', { v: '2026-10-05T14:00:00.123Z', id: 1 })).not.toThrow();
    expect(() => cursorSql(buildSort(def, 'title'), 'asc', { v: 'a\u0000b', id: 1 })).toThrow(BadRequestException);
  });

  it('scopeSql & escapeLike', () => {
    expect(scopeSql('all').sql).toBe('TRUE');
    expect(scopeSql([1, 2]).values).toEqual([[1, 2], [1, 2]]);
    expect(escapeLike('100%_a\\')).toBe('100\\%\\_a\\\\');
  });
});

describe('pageOffset (phân trang theo số trang)', () => {
  it('trang 1 hoặc không có page → 0', () => {
    expect(pageOffset({})).toBe(0);
    expect(pageOffset({ page: 1, limit: 20 })).toBe(0);
  });
  it('trang n → (n-1)*limit; mặc định limit 30', () => {
    expect(pageOffset({ page: 3, limit: 20 })).toBe(40);
    expect(pageOffset({ page: 2 })).toBe(30);
  });
  it('cursor thắng page', () => {
    expect(pageOffset({ page: 5, limit: 20, cursor: 'abc' })).toBe(0);
  });
});

describe('lọc select theo nhãn', () => {
  const tt: FieldDef = { id: 2, key: 'tt', label: 'Trạng thái', type: 'select', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 0, options: { choices: [{ value: 'moi', label: 'Mới' }, { value: 'da_dang_ky', label: 'Đã đăng ký' }] }, help_text: null } as unknown as FieldDef;
  it('value giữ nguyên; nhãn (không phân biệt hoa thường) đổi sang value', () => {
    expect(choiceValues(tt, 'moi')).toEqual(['moi']);
    expect(choiceValues(tt, ['Đã đăng ký', 'mới'])).toEqual(['da_dang_ky', 'moi']);
  });
  it('không khớp lựa chọn nào ⇒ lỗi rõ, liệt kê value hợp lệ', () => {
    expect(() => choiceValues(tt, 'Nghỉ')).toThrow(/không có lựa chọn “Nghỉ”.*moi \(Mới\), da_dang_ky \(Đã đăng ký\)/);
  });
  it('buildFilters dùng value đã đổi trong SQL', () => {
    const d = { obj: { id: 1 }, fields: [tt] } as unknown as ObjectDef;
    const [sql] = buildFilters(d, JSON.stringify({ tt: 'Đã đăng ký' }));
    expect(sql.values).toContainEqual(['da_dang_ky']);
  });
  it('trường chưa khai lựa chọn ⇒ giữ nguyên giá trị', () => {
    expect(choiceValues({ ...tt, options: {} } as FieldDef, 'x')).toEqual(['x']);
  });
});

describe('pruneStaleFilter — bộ lọc đã lưu trong view mà lựa chọn bị xoá', () => {
  const tt = { id: 2, key: 'tt', label: 'Trạng thái', type: 'select', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 0, options: { choices: [{ value: 'moi', label: 'Mới' }] }, help_text: null } as unknown as FieldDef;
  const d = { obj: { id: 1 }, fields: [tt, field('diem', 'number')] } as unknown as ObjectDef;
  it('giá trị không còn tồn tại ⇒ bỏ điều kiện; buildFilters trên kết quả không ném', () => {
    const pruned = pruneStaleFilter(d, { tt: 'da_xoa', diem: { gte: 3 } });
    expect(pruned).toEqual({ diem: { gte: 3 } });
    expect(() => buildFilters(d, JSON.stringify(pruned))).not.toThrow();
  });
  it('còn giá trị hợp lệ ⇒ giữ (nhãn đổi sang value); mảng giữ phần còn lại', () => {
    expect(pruneStaleFilter(d, { tt: 'Mới' })).toEqual({ tt: 'moi' });
    expect(pruneStaleFilter(d, { tt: ['moi', 'da_xoa'] })).toEqual({ tt: ['moi'] });
  });
  it('trường đã bị xoá ⇒ bỏ điều kiện', () => {
    expect(pruneStaleFilter(d, { khong_co: 'x' })).toEqual({});
  });
  it('bộ lọc MỚI với giá trị lạ vẫn báo lỗi rõ', () => {
    expect(() => buildFilters(d, JSON.stringify({ tt: 'da_xoa' }))).toThrow(BadRequestException);
  });
});
