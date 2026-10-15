import { BadRequestException } from '@nestjs/common';
import {
  mergeKanbanAttributes,
  validateKanbanAttributes,
  KanbanFieldDefLike,
} from '../common/kanban-field.validator';

const textDef: KanbanFieldDefLike = { key: 'note', label: 'Ghi chú', type: 'text', options: null, required: false };
const moneyDef: KanbanFieldDefLike = { key: 'gia_tri', label: 'Giá trị', type: 'money', options: null, required: true };
const selectDef: KanbanFieldDefLike = {
  key: 'muc_do',
  label: 'Mức độ',
  type: 'select',
  options: [{ value: 'low', label: 'Thấp' }, { value: 'high', label: 'Cao' }],
  required: false,
};
const checkboxDef: KanbanFieldDefLike = { key: 'da_xong', label: 'Đã xong', type: 'checkbox', options: null, required: false };

describe('validateKanbanAttributes', () => {
  it('defs rỗng + raw rỗng => {}', () => {
    expect(validateKanbanAttributes([], {})).toEqual({});
    expect(validateKanbanAttributes([], undefined)).toEqual({});
  });

  it('defs rỗng + raw có key => 400', () => {
    expect(() => validateKanbanAttributes([], { x: 1 })).toThrow(BadRequestException);
  });

  it('key lạ không thuộc board => 400', () => {
    expect(() => validateKanbanAttributes([textDef], { khong_ton_tai: 'x' })).toThrow(
      BadRequestException,
    );
  });

  it('required thiếu => 400; required rỗng chuỗi => 400', () => {
    expect(() => validateKanbanAttributes([moneyDef], {})).toThrow(BadRequestException);
    expect(() => validateKanbanAttributes([moneyDef], { gia_tri: null })).toThrow(BadRequestException);
  });

  it('money: null vs 0 phân biệt — 0 là giá trị HỢP LỆ (/null-vs-0)', () => {
    const result = validateKanbanAttributes([moneyDef], { gia_tri: 0 });
    expect(result.gia_tri).toBe(0);
  });

  it('money: không âm, phải nguyên', () => {
    expect(() => validateKanbanAttributes([moneyDef], { gia_tri: -5 })).toThrow(BadRequestException);
    expect(() => validateKanbanAttributes([moneyDef], { gia_tri: 1.5 })).toThrow(BadRequestException);
  });

  it('checkbox false KHÔNG bị coi là "rỗng" dù required', () => {
    const requiredCheckbox = { ...checkboxDef, required: true };
    const result = validateKanbanAttributes([requiredCheckbox], { da_xong: false });
    expect(result.da_xong).toBe(false);
  });

  it('select: giá trị ngoài options => 400', () => {
    expect(() => validateKanbanAttributes([selectDef], { muc_do: 'medium' })).toThrow(
      BadRequestException,
    );
  });

  it('select: giá trị hợp lệ => pass', () => {
    expect(validateKanbanAttributes([selectDef], { muc_do: 'high' })).toEqual({ muc_do: 'high' });
  });

  it('optional field không gửi => null, KHÔNG throw', () => {
    expect(validateKanbanAttributes([textDef], {})).toEqual({ note: null });
  });

  it('text vượt trần độ dài => 400', () => {
    expect(() => validateKanbanAttributes([textDef], { note: 'a'.repeat(2001) })).toThrow(
      BadRequestException,
    );
  });
});

describe('mergeKanbanAttributes — giữ nguyên field ĐÃ XOÁ khỏi cấu hình (§Kỹ thuật)', () => {
  it('key mồ côi (không còn def) trong giá trị cũ được GIỮ NGUYÊN', () => {
    const existing = { note: 'cũ', field_da_xoa: 'giá trị cũ vẫn còn' };
    const validatedNew = validateKanbanAttributes([textDef], { note: 'mới' });
    const merged = mergeKanbanAttributes(existing, validatedNew);
    expect(merged).toEqual({ note: 'mới', field_da_xoa: 'giá trị cũ vẫn còn' });
  });

  it('existing null/undefined => merge từ rỗng, không crash', () => {
    const validatedNew = validateKanbanAttributes([textDef], { note: 'x' });
    expect(mergeKanbanAttributes(null, validatedNew)).toEqual({ note: 'x' });
    expect(mergeKanbanAttributes(undefined, validatedNew)).toEqual({ note: 'x' });
  });
});

describe('validateKanbanAttributes — partial (PATCH)', () => {
  const defs = [
    { key: 'a', label: 'A', type: 'text', options: null, required: true },
    { key: 'b', label: 'B', type: 'text', options: null, required: false },
  ];
  it('key vắng mặt không bị ghi đè null và không bị bắt bắt buộc', () => {
    const v = validateKanbanAttributes(defs, { b: 'mới' }, { partial: true });
    expect(v).toEqual({ b: 'mới' });
    expect(mergeKanbanAttributes({ a: 'cũ', b: 'x' }, v)).toEqual({ a: 'cũ', b: 'mới' });
  });
  it('key có gửi mà rỗng vẫn bị kiểm bắt buộc', () => {
    expect(() => validateKanbanAttributes(defs, { a: '' }, { partial: true })).toThrow();
  });
});
