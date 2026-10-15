import { BadRequestException } from '@nestjs/common';
import { AttributeDefLike, validateProductAttributes } from '../product-attributes.validator';

const def = (over: Partial<AttributeDefLike>): AttributeDefLike => ({
  key: 'material',
  label: 'Chất liệu',
  type: 'text',
  options: null,
  is_required: false,
  ...over,
});

describe('validateProductAttributes', () => {
  describe('không có def nào (category_id=null)', () => {
    it('attributes rỗng/undefined → {} ', () => {
      expect(validateProductAttributes([], undefined)).toEqual({});
      expect(validateProductAttributes([], null)).toEqual({});
      expect(validateProductAttributes([], {})).toEqual({});
    });

    it('attributes có key → 400 (không có def để gán giá trị)', () => {
      expect(() => validateProductAttributes([], { x: 1 })).toThrow(BadRequestException);
    });
  });

  describe('whitelist key', () => {
    it('key lạ không thuộc bất kỳ def nào → 400', () => {
      expect(() =>
        validateProductAttributes([def({ key: 'a' })], { b: '1' }),
      ).toThrow(BadRequestException);
    });

    it('key hợp lệ nhưng thiếu (optional) → set null, KHÔNG throw', () => {
      const out = validateProductAttributes([def({ key: 'a', is_required: false })], {});
      expect(out).toEqual({ a: null });
    });
  });

  describe('is_required', () => {
    it('required + thiếu → 400', () => {
      expect(() =>
        validateProductAttributes([def({ is_required: true })], {}),
      ).toThrow(BadRequestException);
    });

    it('required + chuỗi rỗng → 400 (rỗng coi như thiếu)', () => {
      expect(() =>
        validateProductAttributes([def({ is_required: true })], { material: '' }),
      ).toThrow(BadRequestException);
    });

    it('required + có giá trị → qua', () => {
      const out = validateProductAttributes(
        [def({ is_required: true })],
        { material: 'Cotton' },
      );
      expect(out).toEqual({ material: 'Cotton' });
    });
  });

  describe('type=text/textarea', () => {
    it('không phải chuỗi → 400', () => {
      expect(() =>
        validateProductAttributes([def({ type: 'text' })], { material: 123 }),
      ).toThrow(BadRequestException);
    });

    it('vượt trần độ dài → 400', () => {
      expect(() =>
        validateProductAttributes([def({ type: 'text' })], {
          material: 'x'.repeat(501),
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('type=number/currency', () => {
    it('chuỗi số hợp lệ → ép về number', () => {
      const out = validateProductAttributes(
        [def({ key: 'warranty_months', type: 'number' })],
        { warranty_months: '12' },
      );
      expect(out).toEqual({ warranty_months: 12 });
    });

    it('boolean KHÔNG được coi là number hợp lệ (Number(true)=1 là bẫy)', () => {
      expect(() =>
        validateProductAttributes([def({ key: 'x', type: 'number' })], { x: true }),
      ).toThrow(BadRequestException);
    });

    it('NaN/chuỗi rác → 400', () => {
      expect(() =>
        validateProductAttributes([def({ key: 'x', type: 'currency' })], { x: 'abc' }),
      ).toThrow(BadRequestException);
    });

    it('vượt trần → 400', () => {
      expect(() =>
        validateProductAttributes([def({ key: 'x', type: 'currency' })], {
          x: 2_000_000_000_000,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('type=percent', () => {
    it('0 và 100 hợp lệ (biên)', () => {
      expect(
        validateProductAttributes([def({ key: 'rate', type: 'percent' })], { rate: 0 }),
      ).toEqual({ rate: 0 });
      expect(
        validateProductAttributes([def({ key: 'rate', type: 'percent' })], { rate: 100 }),
      ).toEqual({ rate: 100 });
    });

    it('ngoài 0-100 → 400', () => {
      expect(() =>
        validateProductAttributes([def({ key: 'rate', type: 'percent' })], { rate: 101 }),
      ).toThrow(BadRequestException);
      expect(() =>
        validateProductAttributes([def({ key: 'rate', type: 'percent' })], { rate: -1 }),
      ).toThrow(BadRequestException);
    });
  });

  describe('type=date', () => {
    it('ISO hợp lệ → qua', () => {
      const out = validateProductAttributes(
        [def({ key: 'expiry', type: 'date' })],
        { expiry: '2026-12-31' },
      );
      expect(out).toEqual({ expiry: '2026-12-31' });
    });

    it('chuỗi không parse được → 400', () => {
      expect(() =>
        validateProductAttributes([def({ key: 'expiry', type: 'date' })], {
          expiry: 'khong-phai-ngay',
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('type=boolean', () => {
    it('true/false hợp lệ', () => {
      expect(
        validateProductAttributes([def({ key: 'active', type: 'boolean' })], { active: true }),
      ).toEqual({ active: true });
    });

    it('chuỗi "true" KHÔNG tự ép — phải là boolean thật', () => {
      expect(() =>
        validateProductAttributes([def({ key: 'active', type: 'boolean' })], {
          active: 'true',
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('type=select', () => {
    const selectDef = def({
      key: 'size',
      type: 'select',
      options: [
        { value: 's', label: 'Nhỏ' },
        { value: 'm', label: 'Vừa' },
      ],
    });

    it('giá trị thuộc options → qua', () => {
      expect(validateProductAttributes([selectDef], { size: 's' })).toEqual({ size: 's' });
    });

    it('giá trị KHÔNG thuộc options → 400', () => {
      expect(() => validateProductAttributes([selectDef], { size: 'xl' })).toThrow(
        BadRequestException,
      );
    });

    it('def thiếu options (cấu hình hỏng) → 400 LOUD, không đoán mò', () => {
      expect(() =>
        validateProductAttributes([def({ key: 'size', type: 'select', options: null })], {
          size: 's',
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('type=multiselect', () => {
    const msDef = def({
      key: 'colors',
      type: 'multiselect',
      options: [
        { value: 'red', label: 'Đỏ' },
        { value: 'blue', label: 'Xanh' },
      ],
    });

    it('mảng con của options → qua', () => {
      expect(validateProductAttributes([msDef], { colors: ['red', 'blue'] })).toEqual({
        colors: ['red', 'blue'],
      });
    });

    it('1 phần tử ngoài options → 400 (chặn cả mảng, không lọc âm thầm)', () => {
      expect(() =>
        validateProductAttributes([msDef], { colors: ['red', 'green'] }),
      ).toThrow(BadRequestException);
    });

    it('không phải mảng → 400', () => {
      expect(() => validateProductAttributes([msDef], { colors: 'red' })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('nhiều field cùng lúc', () => {
    it('validate ĐỦ mọi def, kể cả field không gửi (set null)', () => {
      const defs = [
        def({ key: 'a', type: 'text', is_required: true }),
        def({ key: 'b', type: 'number', is_required: false }),
      ];
      const out = validateProductAttributes(defs, { a: 'x' });
      expect(out).toEqual({ a: 'x', b: null });
    });
  });

  describe('attributes không phải object', () => {
    it('mảng → 400', () => {
      expect(() => validateProductAttributes([def({})], [] as unknown)).toThrow(
        BadRequestException,
      );
    });

    it('chuỗi → 400', () => {
      expect(() => validateProductAttributes([def({})], 'x' as unknown)).toThrow(
        BadRequestException,
      );
    });
  });
});
