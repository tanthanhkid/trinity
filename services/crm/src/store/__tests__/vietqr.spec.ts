import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIETQR_BANKS, buildVietQr, crc16, findVietQrBank, vietQrContent } from '../vietqr';
import { crcTable, decodeEmv } from './emv-decoder';

/**
 * 10 mẫu đối chiếu: tên ngân hàng kiểu SePay → BIN, rồi chuỗi VietQR. Chuỗi mong đợi sinh bằng một bản cài Python độc
 * lập (không chung mã với vietqr.ts), CRC-16/CCITT-FALSE.
 */
const SAMPLES: Array<[bank: string, bin: string, account: string, amount: number, content: string, qr: string]> = [
  ['MBBank', '970422', '0123456789', 199000, 'DH-ABCDEF', '00020101021238540010A00000072701240006970422011001234567890208QRIBFTTA530370454061990005802VN62130809DH-ABCDEF63046DD8'],
  ['Vietcombank', '970436', '1012345678', 50000, 'DH-2K7QXM', '00020101021238540010A00000072701240006970436011010123456780208QRIBFTTA53037045405500005802VN62130809DH-2K7QXM63041C73'],
  ['VietinBank', '970415', '108000123456', 1500000, 'DH-PQRSTU', '00020101021238560010A0000007270126000697041501121080001234560208QRIBFTTA5303704540715000005802VN62130809DH-PQRSTU63042760'],
  ['BIDV', '970418', '21510001234567', 1000, 'DH-AAAAAA', '00020101021238580010A000000727012800069704180114215100012345670208QRIBFTTA5303704540410005802VN62130809DH-AAAAAA63047980'],
  ['Techcombank', '970407', '19036789012345', 2500000, 'DH-Z9Z9Z9', '00020101021238580010A000000727012800069704070114190367890123450208QRIBFTTA5303704540725000005802VN62130809DH-Z9Z9Z963049EFE'],
  ['ACB', '970416', '12345678', 10000000000, 'DH-HJKLMN', '00020101021238520010A000000727012200069704160108123456780208QRIBFTTA53037045411100000000005802VN62130809DH-HJKLMN6304548D'],
  ['TPBank', '970423', '00001234567', 75500, 'DH-BCDEFG', '00020101021238550010A000000727012500069704230111000012345670208QRIBFTTA53037045405755005802VN62130809DH-BCDEFG63049DEF'],
  ['LienVietPostBank', '970449', 'LPB0001234', 320000, 'DH-WXYZ23', '00020101021238540010A000000727012400069704490110LPB00012340208QRIBFTTA530370454063200005802VN62130809DH-WXYZ23630430F1'],
  ['HDBank', '970437', '068704070001234', 99000, 'DH-456789', '00020101021238590010A0000007270129000697043701150687040700012340208QRIBFTTA53037045405990005802VN62130809DH-4567896304437B'],
  ['Nam A Bank', '970428', '9999888877776666555', 123456789, 'DH-QWERTY', '00020101021238630010A00000072701330006970428011999998888777766665550208QRIBFTTA530370454091234567895802VN62130809DH-QWERTY6304D2EA'],
];

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
