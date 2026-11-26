/**
 * Bộ giải mã EMVCo ĐỘC LẬP cho test (không dùng lại mã của vietqr.ts): tách TLV, đọc trường VietQR, kiểm CRC bằng thuật
 * toán dùng bảng tra (khác cách tính từng bit của bản sinh).
 */
const TABLE = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    t.push(c & 0xffff);
  }
  return t;
})();

export function crcTable(text: string): number {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ text.charCodeAt(i)) & 0xff]) & 0xffff;
  return crc;
}

export function parseTlv(s: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len) || i + 4 + len > s.length) throw new Error(`TLV hỏng ở vị trí ${i}`);
    if (out.has(id)) throw new Error(`Trùng trường ${id}`);
    out.set(id, s.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}

export function decodeEmv(s: string) {
  const top = parseTlv(s);
  const merchant = parseTlv(top.get('38') ?? '');
  const beneficiary = parseTlv(merchant.get('01') ?? '');
  const extra = top.has('62') ? parseTlv(top.get('62')!) : new Map<string, string>();
  const crc = top.get('63') ?? '';
  return {
    format: top.get('00'),
    initiation: top.get('01'),
    guid: merchant.get('00'),
    service: merchant.get('02'),
    bin: beneficiary.get('00'),
    account: beneficiary.get('01'),
    currency: top.get('53'),
    amount: top.get('54'),
    country: top.get('58'),
    content: extra.get('08'),
    crcOk: s.endsWith(crc) && crc === crcTable(s.slice(0, -4)).toString(16).toUpperCase().padStart(4, '0'),
  };
}
