import { normalizeValue, ValueError } from '../field-values';
import { extractMentionCodes, parseRef } from '../refs/ref-types';
import { foldVi, SQL_FOLD_FROM, SQL_FOLD_TO } from '../refs/fold-vi';
import { previewText, vnDateTime } from '../refs/ref-preview.service';
import type { FieldDef } from '../field-types';

const LINK = { label: 'Liên quan', type: 'link' as const, options: {} };

describe('gắn thẻ @ — phần thuần (BE)', () => {
  it('extractMentionCodes: chuẩn hoá, không trùng, bỏ email / mã dính chữ', () => {
    expect(extractMentionCodes('Khám @hs1 và @HS001, gọi @BN020. mail a@hs002.vn @KH003x')).toEqual(['HS001', 'BN020']);
    expect(extractMentionCodes('(@KHO1000)')).toEqual(['KHO1000']);
  });
  it('parseRef chỉ nhận loại:id hợp lệ', () => {
    expect(parseRef('record:12')).toEqual({ type: 'record', id: 12 });
    expect(parseRef('task:3')).toEqual({ type: 'task', id: 3 });
    expect(parseRef('user:1')).toBeNull();
    expect(parseRef('record:0')).toBeNull();
    expect(parseRef(12)).toBeNull();
  });
  it('trường Liên kết: nhận mã / @mã / loại:id / chuỗi dán nhiều mã; từ chối thứ khác', () => {
    expect(normalizeValue(LINK, ['@HS001', 'record:4', 'HS001'])).toEqual(['HS001', 'record:4']);
    expect(normalizeValue(LINK, 'HS001, KH002; BN003')).toEqual(['HS001', 'KH002', 'BN003']);
    expect(normalizeValue(LINK, [])).toBeNull();
    expect(() => normalizeValue(LINK, ['Nguyễn'])).toThrow(ValueError);
    expect(() => normalizeValue(LINK, [{ id: 1 }])).toThrow(ValueError);
    expect(() => normalizeValue(LINK, Array.from({ length: 51 }, (_, i) => `HS${i + 1}`))).toThrow(/tối đa 50/);
  });
  it('xem nhanh: lựa chọn ra nhãn, liên kết ra tên, chữ dài bị cắt', () => {
    const sel = { key: 'tt', label: 'Trạng thái', type: 'select', options: { choices: [{ value: 'moi', label: 'Mới' }] } } as unknown as FieldDef;
    const rec = { data: { tt: 'moi', ghi: 'x'.repeat(200) }, relations: {} } as never;
    expect(previewText(sel, rec)).toBe('Mới');
    expect(previewText({ key: 'ghi', type: 'text', options: {} } as unknown as FieldDef, rec)?.length).toBe(118);
  });
  it('xem nhanh: ngày giờ ra dd/MM/yyyy HH:mm giờ VN, không còn ISO thô', () => {
    const dt = { key: 'hen', type: 'datetime', options: {} } as unknown as FieldDef;
    const rec = { data: { hen: '2026-10-09T17:30:00.000Z' }, relations: {} } as never;
    expect(previewText(dt, rec)).toBe('10/10/2026 00:30');
    expect(vnDateTime('2026-01-05T01:05:00Z')).toBe('05/01/2026 08:05');
    expect(vnDateTime('không phải ngày')).toBe('không phải ngày');
  });
  it('bỏ dấu tiếng Việt: Nguyễn → nguyen, Đặng → dang; bảng SQL khớp độ dài', () => {
    expect(foldVi('Nguyễn Văn Đức')).toBe('nguyen van duc');
    expect(foldVi('ĐẶNG Thị Ánh')).toBe('dang thi anh');
    expect(foldVi('nguyen')).toBe('nguyen');
    expect([...SQL_FOLD_FROM].length).toBe([...SQL_FOLD_TO].length);
    expect([...SQL_FOLD_FROM].map((c) => foldVi(c)).join('')).toBe(SQL_FOLD_TO);
    expect(SQL_FOLD_TO).toMatch(/^[a-z]+$/);
  });
});
