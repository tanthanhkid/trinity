import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaService } from '@trinity/prisma';
import { formatCode, normalizePrefix, parseCode, renamePrefix } from '../record-codes';
import { recordSearchSql } from '../custom-records-list.service';
import type { ObjectDef } from '../custom-object-access';

describe('mã chung — định dạng', () => {
  it('formatCode khớp trinity_code_num của DB: đệm 3 chữ số, không cắt khi ≥ 1000', () => {
    expect(formatCode('HS', 1)).toBe('HS001');
    expect(formatCode('HS', 42)).toBe('HS042');
    expect(formatCode('HS', 999)).toBe('HS999');
    expect(formatCode('HS', 1000)).toBe('HS1000');
  });

  it('parseCode nhận chữ thường / thiếu số 0, trả mã chuẩn; sai dạng → null', () => {
    expect(parseCode('hs1')).toEqual({ prefix: 'HS', seq: 1, code: 'HS001' });
    expect(parseCode(' KHO012 ')).toEqual({ prefix: 'KHO', seq: 12, code: 'KHO012' });
    expect(parseCode('HS')).toBeNull();
    expect(parseCode('H001')).toBeNull();
    expect(parseCode('HSABC1')).toBeNull();
    expect(parseCode('HS000')).toBeNull();
    expect(parseCode('Nguyễn')).toBeNull();
  });

  it('normalizePrefix: 2–4 chữ in hoa, không lấy tiền tố bảng lõi', () => {
    expect(normalizePrefix('bn')).toBe('BN');
    expect(() => normalizePrefix('B')).toThrow(/2–4/);
    expect(() => normalizePrefix('HS1')).toThrow(/2–4/);
    expect(() => normalizePrefix('Đơn')).toThrow(/2–4/);
    expect(() => normalizePrefix('kh')).toThrow(/bảng lõi/);
    expect(() => normalizePrefix('CV')).toThrow(/bảng lõi/);
  });

  it('ô tìm của danh sách khớp tiêu đề (bỏ dấu) HOẶC đầu mã (in hoa)', () => {
    const sql = recordSearchSql({ obj: {}, fields: [] } as unknown as ObjectDef, 'hs0');
    expect(sql.sql).toContain('translate(lower(title)');
    expect(sql.sql).toContain('code LIKE');
    expect(sql.values).toEqual(expect.arrayContaining(['%hs0%', 'HS0%']));
  });
});

describe('renamePrefix — đổi tiền tố bảng', () => {
  function fakePrisma(cur: { code_prefix: string | null; code_prefix_aliases: string[] }, taken: boolean) {
    const calls: { update?: unknown; recode?: unknown[] } = {};
    const tx = {
      $executeRaw: jest.fn(async (q: { sql: string; values: unknown[] }) => { if (q.sql.includes('UPDATE custom_records')) calls.recode = q.values; return 1; }),
      $queryRaw: jest.fn(async () => [{ taken }]),
      customObject: {
        findUniqueOrThrow: jest.fn(async () => cur),
        update: jest.fn(async (a: unknown) => { calls.update = a; return {}; }),
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
    return { prisma, calls };
  }

  it('tiền tố cũ vào alias (mã cũ vẫn tra được), mã bản ghi đổi theo, số giữ nguyên', async () => {
    const { prisma, calls } = fakePrisma({ code_prefix: 'KHO', code_prefix_aliases: [] }, false);
    await expect(renamePrefix(prisma, 7, 'khoa')).resolves.toBe('KHOA');
    expect(calls.update).toEqual({ where: { id: 7 }, data: { code_prefix: 'KHOA', code_prefix_aliases: ['KHO'] } });
    expect(calls.recode).toEqual(['KHOA', 7]);
  });

  it('lấy lại tiền tố cũ của CHÍNH bảng mình thì bỏ khỏi alias', async () => {
    const { prisma, calls } = fakePrisma({ code_prefix: 'KHOA', code_prefix_aliases: ['KHO'] }, false);
    await renamePrefix(prisma, 7, 'KHO');
    expect(calls.update).toEqual({ where: { id: 7 }, data: { code_prefix: 'KHO', code_prefix_aliases: ['KHOA'] } });
  });

  it('tiền tố đã có bảng khác dùng (kể cả từng dùng) → 409, không đổi gì', async () => {
    const { prisma, calls } = fakePrisma({ code_prefix: 'HS', code_prefix_aliases: [] }, true);
    await expect(renamePrefix(prisma, 7, 'BN')).rejects.toBeInstanceOf(ConflictException);
    expect(calls.update).toBeUndefined();
    expect(calls.recode).toBeUndefined();
  });
});

describe('normalizePrefix — null từ PATCH', () => {
  it('code_prefix: null → 400, không TypeError', () => {
    expect(() => normalizePrefix(null as unknown as string)).toThrow(BadRequestException);
  });
});
