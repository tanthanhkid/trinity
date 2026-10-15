/**
 * VietQR / NAPAS 247 (EMVCo) — dựng CHUỖI QR chuyển khoản tới tài khoản ngân hàng.
 * KHÔNG gọi API ngân hàng nào; FE vẽ QR từ chuỗi này. Tham chiếu định dạng: 00 (version),
 * 01 (11 tĩnh / 12 động có số tiền), 38 (NAPAS: GUID A000000727 + BIN + STK + dịch vụ QRIBFTTA),
 * 53=704 (VND), 54 (số tiền), 58=VN, 62/08 (nội dung), 63 (CRC16-CCITT-FALSE).
 */
const NAPAS_GUID = 'A000000727';

function tlv(id: string, value: string): string {
  return id + String(value.length).padStart(2, '0') + value;
}

/** CRC16 CCITT-FALSE (poly 0x1021, init 0xFFFF) — 4 ký tự hex HOA. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Nội dung CK: bỏ dấu, chỉ ASCII an toàn, tối đa 25 ký tự (giới hạn thực tế của app ngân hàng). */
export function sanitizeQrMessage(msg: string): string {
  return msg
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .slice(0, 25);
}

export interface VietQrInput {
  bin: string;
  accountNo: string;
  amount?: number;
  message?: string;
}

export function buildVietQr(input: VietQrInput): string {
  if (!/^\d{6}$/.test(input.bin)) throw new Error('BIN ngân hàng phải gồm 6 chữ số');
  if (!/^\d{4,19}$/.test(input.accountNo)) throw new Error('Số tài khoản phải gồm 4–19 chữ số');
  const dynamic = input.amount !== undefined && input.amount > 0;
  const bank = tlv('00', input.bin) + tlv('01', input.accountNo);
  const merchant = tlv('00', NAPAS_GUID) + tlv('01', bank) + tlv('02', 'QRIBFTTA');
  let body = tlv('00', '01') + tlv('01', dynamic ? '12' : '11') + tlv('38', merchant) + tlv('53', '704');
  if (dynamic) body += tlv('54', String(Math.trunc(input.amount as number)));
  body += tlv('58', 'VN');
  const msg = input.message ? sanitizeQrMessage(input.message) : '';
  if (msg) body += tlv('62', tlv('08', msg));
  body += '6304';
  return body + crc16(body);
}
