import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIETQR_BANKS, buildVietQr, crc16, findVietQrBank, vietQrContent } from '../vietqr';
import { crcTable, decodeEmv } from './emv-decoder';

/**
 * 10 mẫu đối chiếu (bảng dùng chung với Rust: server/contracts/cases/vietqr.json): tên ngân hàng kiểu SePay → BIN, rồi chuỗi VietQR. Chuỗi mong đợi sinh bằng một bản cài Python độc
 * lập (không chung mã với vietqr.ts), CRC-16/CCITT-FALSE.
 */
const CASES = JSON.parse(readFileSync(join(__dirname, '../../../../../server/contracts/cases/vietqr.json'), 'utf8')) as {
  samples: Array<{ bank: string; bin: string; account: string; amount: number; content: string; qr: string }>;
};
const SAMPLES: Array<[bank: string, bin: string, account: string, amount: number, content: string, qr: string]> = CASES.samples.map((c) => [c.bank, c.bin, c.account, c.amount, c.content, c.qr]);

describe('VietQR', () => {
  it('CRC-16/CCITT-FALSE đúng vector chuẩn ("123456789" ⇒ 29B1), khớp bản tính bằng bảng tra', () => {
    expect(crc16('123456789')).toBe('29B1');
    expect(crcTable('123456789')).toBe(0x29b1);
  });

  it.each(SAMPLES)('%s → %s: chuỗi khớp mẫu, bộ giải mã độc lập đọc lại đúng', (bankName, bin, account, amount, content, expected) => {
    const bank = findVietQrBank(bankName);
    expect(bank?.bin).toBe(bin);
    const qr = buildVietQr({ bin: bank!.bin, account, amount, content });
    expect(qr).toBe(expected);
    expect(decodeEmv(qr)).toEqual({
      format: '01', initiation: '12', guid: 'A000000727', service: 'QRIBFTTA', bin, account, currency: '704', amount: String(amount), country: 'VN', content, crcOk: true,
    });
  });

  it('ánh xạ tên ngân hàng: bỏ dấu cách/chấm/gạch, không phân biệt hoa thường, nhận BIN; tên lạ ⇒ null', () => {
    expect(findVietQrBank(' mb bank ')?.bin).toBe('970422');
    expect(findVietQrBank('VCB')?.bin).toBe('970436');
    expect(findVietQrBank('970437')?.name).toBe('HDBank');
    expect(findVietQrBank('NganHangKhongCo')).toBeNull();
    expect(findVietQrBank('123456')).toBeNull();
    expect(findVietQrBank('')).toBeNull();
  });

  it('bảng ánh xạ: BIN 6 số không trùng, tên gọi không trùng giữa hai ngân hàng', () => {
    const bins = VIETQR_BANKS.map((b) => b.bin);
    expect(new Set(bins).size).toBe(bins.length);
    for (const b of bins) expect(b).toMatch(/^\d{6}$/);
    const aliases = VIETQR_BANKS.flatMap((b) => b.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const a of aliases) expect(a).toMatch(/^[a-z0-9]+$/);
  });

  it('migration 0022 chép đúng bảng ánh xạ (không lệch giữa SQL và TS)', () => {
    const sql = readFileSync(join(__dirname, '../../../../../packages/prisma/prisma/migrations/0022_store_vietqr/migration.sql'), 'utf8');
    const fromSql = [...sql.matchAll(/\('([a-z0-9]+)', '(\d{6})'\)/g)].map((m) => `${m[1]}=${m[2]}`).sort();
    const fromTs = VIETQR_BANKS.flatMap((b) => b.aliases.map((a) => `${a}=${b.bin}`)).sort();
    expect(fromSql).toEqual(fromTs);
  });

  it('nội dung: bỏ dấu tiếng Việt và ký tự lạ, tối đa 25 ký tự; tham số sai ⇒ lỗi', () => {
    expect(vietQrContent('Đơn hàng #12 — ổn!')).toBe('Don hang 12 on');
    expect(vietQrContent('x'.repeat(40))).toHaveLength(25);
    expect(() => buildVietQr({ bin: '97042', account: '0123456789', amount: 1000, content: 'a' })).toThrow('BIN');
    expect(() => buildVietQr({ bin: '970422', account: '01-23', amount: 1000, content: 'a' })).toThrow('tài khoản');
    expect(() => buildVietQr({ bin: '970422', account: '0123456789', amount: 0, content: 'a' })).toThrow('Số tiền');
    expect(() => buildVietQr({ bin: '970422', account: '0123456789', amount: 1.5, content: 'a' })).toThrow('Số tiền');
  });
});
