import { buildVietQr, crc16, sanitizeQrMessage } from '../vietqr.util';

/** Tách chuỗi TLV phẳng để kiểm cấu trúc thật thay vì so chuỗi cứng. */
function parse(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < s.length; ) {
    const id = s.slice(i, i + 2);
    const len = parseInt(s.slice(i + 2, i + 4), 10);
    out[id] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

describe('VietQR', () => {
  it('CRC16-CCITT-FALSE đúng vector chuẩn "123456789" = 29B1', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('QR động: cấu trúc NAPAS 247 + số tiền + nội dung + CRC hợp lệ', () => {
    const qr = buildVietQr({ bin: '970436', accountNo: '0123456789', amount: 125000, message: 'HD20260930-0001' });
    const t = parse(qr);
    expect(t['00']).toBe('01');
    expect(t['01']).toBe('12');
    expect(t['53']).toBe('704');
    expect(t['54']).toBe('125000');
    expect(t['58']).toBe('VN');
    const n = parse(t['38']);
    expect(n['00']).toBe('A000000727');
    expect(n['02']).toBe('QRIBFTTA');
    expect(parse(n['01'])).toEqual({ '00': '970436', '01': '0123456789' });
    expect(parse(t['62'])['08']).toBe('HD20260930-0001');
    // CRC nằm cuối và tính trên toàn bộ phần trước nó (gồm "6304").
    expect(qr.slice(-4)).toBe(crc16(qr.slice(0, -4)));
    expect(qr.slice(-8, -4)).toBe('6304');
  });

  it('không có số tiền → QR tĩnh (01 = 11), không có tag 54', () => {
    const t = parse(buildVietQr({ bin: '970436', accountNo: '0123456789' }));
    expect(t['01']).toBe('11');
    expect(t['54']).toBeUndefined();
  });

  it('nội dung được bỏ dấu và cắt 25 ký tự', () => {
    expect(sanitizeQrMessage('Thanh toán đơn hàng số 1')).toBe('Thanh toan don hang so 1');
    expect(sanitizeQrMessage('x'.repeat(40))).toHaveLength(25);
  });

  it('BIN/STK sai định dạng bị từ chối', () => {
    expect(() => buildVietQr({ bin: '97043', accountNo: '0123456789' })).toThrow();
    expect(() => buildVietQr({ bin: '970436', accountNo: '12ab' })).toThrow();
  });
});
