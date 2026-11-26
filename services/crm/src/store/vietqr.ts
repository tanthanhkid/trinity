/**
 * Chuỗi VietQR (chuẩn EMVCo Merchant-Presented QR, hồ sơ NAPAS "chuyển tiền tới tài khoản") — sinh hoàn toàn trong máy
 * chủ, KHÔNG gọi dịch vụ ngoài; trình duyệt vẽ chuỗi thành mã QR. App ngân hàng quét là điền sẵn tài khoản, số tiền, nội dung.
 *
 * Cấu trúc (mỗi trường = ID 2 số + độ dài 2 số + giá trị):
 *   00 "01" · 01 "12" (QR động, có số tiền) · 38 { 00 "A000000727" (NAPAS) · 01 { 00 BIN · 01 số TK } · 02 "QRIBFTTA" }
 *   · 53 "704" (VND) · 54 số tiền · 58 "VN" · 62 { 08 nội dung } · 63 CRC16-CCITT-FALSE (4 hex in hoa) tính trên mọi thứ tới "6304".
 */

/** Ngân hàng nhận VietQR: mã BIN 6 số (NAPAS), tên ngắn hiển thị, và các tên/mã viết kiểu SePay/VietQR để ánh xạ. */
export interface VietQrBank {
  bin: string;
  name: string;
  aliases: readonly string[];
}

/**
 * Bảng ánh xạ tên ngân hàng (kiểu SePay: "MBBank", "Vietcombank"…, hoặc mã: "VCB", "ICB"…) → BIN. Tên so khớp sau khi bỏ
 * dấu cách, chấm, gạch và không phân biệt hoa thường. Migration `0022_store_vietqr` chép đúng bảng này (test kiểm khớp).
 */
export const VIETQR_BANKS: readonly VietQrBank[] = [
  { bin: '970436', name: 'Vietcombank', aliases: ['vietcombank', 'vcb'] },
  { bin: '970415', name: 'VietinBank', aliases: ['vietinbank', 'icb', 'ctg'] },
  { bin: '970418', name: 'BIDV', aliases: ['bidv'] },
  { bin: '970405', name: 'Agribank', aliases: ['agribank', 'vba'] },
  { bin: '970422', name: 'MBBank', aliases: ['mbbank', 'mb'] },
  { bin: '970407', name: 'Techcombank', aliases: ['techcombank', 'tcb'] },
  { bin: '970416', name: 'ACB', aliases: ['acb'] },
  { bin: '970432', name: 'VPBank', aliases: ['vpbank', 'vpb'] },
  { bin: '970423', name: 'TPBank', aliases: ['tpbank', 'tpb'] },
  { bin: '970403', name: 'Sacombank', aliases: ['sacombank', 'stb'] },
  { bin: '970437', name: 'HDBank', aliases: ['hdbank', 'hdb'] },
  { bin: '970441', name: 'VIB', aliases: ['vib'] },
  { bin: '970443', name: 'SHB', aliases: ['shb'] },
  { bin: '970431', name: 'Eximbank', aliases: ['eximbank', 'eib'] },
  { bin: '970426', name: 'MSB', aliases: ['msb', 'maritimebank'] },
  { bin: '970429', name: 'SCB', aliases: ['scb'] },
  { bin: '970440', name: 'SeABank', aliases: ['seabank', 'seab'] },
  { bin: '970448', name: 'OCB', aliases: ['ocb'] },
  { bin: '970449', name: 'LPBank', aliases: ['lpbank', 'lienvietpostbank', 'lpb'] },
  { bin: '970428', name: 'Nam A Bank', aliases: ['namabank', 'nab'] },
  { bin: '970412', name: 'PVcomBank', aliases: ['pvcombank', 'pvcb'] },
  { bin: '970409', name: 'Bac A Bank', aliases: ['bacabank', 'bab'] },
  { bin: '970425', name: 'ABBANK', aliases: ['abbank', 'abb'] },
  { bin: '970427', name: 'VietABank', aliases: ['vietabank', 'vab'] },
  { bin: '970419', name: 'NCB', aliases: ['ncb'] },
  { bin: '970452', name: 'KienlongBank', aliases: ['kienlongbank', 'klb'] },
  { bin: '970454', name: 'BVBank', aliases: ['bvbank', 'vietcapitalbank', 'vccb'] },
  { bin: '970433', name: 'VietBank', aliases: ['vietbank'] },
  { bin: '970438', name: 'BaoViet Bank', aliases: ['baovietbank', 'bvb'] },
  { bin: '970400', name: 'SaigonBank', aliases: ['saigonbank', 'sgicb'] },
  { bin: '970430', name: 'PGBank', aliases: ['pgbank', 'pgb'] },
  { bin: '970408', name: 'GPBank', aliases: ['gpbank', 'gpb'] },
  { bin: '970414', name: 'MBV (OceanBank)', aliases: ['oceanbank', 'mbv'] },
  { bin: '970406', name: 'Vikki Bank (DongA)', aliases: ['vikkibank', 'dongabank', 'dab'] },
  { bin: '546034', name: 'CAKE', aliases: ['cake'] },
  { bin: '546035', name: 'Ubank', aliases: ['ubank'] },
  { bin: '963388', name: 'Timo', aliases: ['timo'] },
  { bin: '970457', name: 'Woori', aliases: ['woori', 'wvn'] },
  { bin: '970424', name: 'Shinhan Bank', aliases: ['shinhanbank', 'shinhan', 'shbvn'] },
  { bin: '970458', name: 'UOB', aliases: ['uob'] },
  { bin: '970439', name: 'Public Bank', aliases: ['publicbank', 'pbvn'] },
  { bin: '458761', name: 'HSBC', aliases: ['hsbc'] },
  { bin: '970434', name: 'Indovina', aliases: ['indovinabank', 'ivb'] },
  { bin: '970421', name: 'VRB', aliases: ['vrb'] },
  { bin: '970410', name: 'Standard Chartered', aliases: ['standardchartered', 'scvn'] },
];

const aliasKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Tên/mã ngân hàng kiểu SePay hoặc BIN 6 số → ngân hàng; không có trong bảng ⇒ null. */
export function findVietQrBank(nameOrBin: string | null | undefined): VietQrBank | null {
  const raw = String(nameOrBin ?? '').trim();
  if (/^\d{6}$/.test(raw)) return VIETQR_BANKS.find((b) => b.bin === raw) ?? null;
  const key = aliasKey(raw);
  if (!key) return null;
  return VIETQR_BANKS.find((b) => b.aliases.includes(key)) ?? null;
}

/** CRC-16/CCITT-FALSE (đa thức 0x1021, khởi tạo 0xFFFF) — 4 ký tự hex in hoa. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const tlv = (id: string, value: string) => {
  if (value.length > 99) throw new Error(`Trường ${id} quá dài`);
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
};

/** Số tài khoản nhận VietQR: 4–19 chữ số/chữ cái. */
export const VIETQR_ACCOUNT_RE = /^[0-9A-Za-z]{4,19}$/;

/** Nội dung chuyển khoản: chỉ chữ không dấu, số, dấu cách, gạch; tối đa 25 ký tự (app ngân hàng hay cắt/bỏ ký tự lạ). */
export function vietQrContent(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .replace(/[^A-Za-z0-9 -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 25);
}

/**
 * Chuỗi VietQR chuyển tới tài khoản `account` ở ngân hàng `bin`, số tiền `amount` (VND, số nguyên dương), nội dung `content`.
 * Hàm thuần: cùng đầu vào ⇒ cùng chuỗi.
 */
export function buildVietQr(opts: { bin: string; account: string; amount: number; content: string }): string {
  if (!/^\d{6}$/.test(opts.bin)) throw new Error('BIN ngân hàng phải là 6 chữ số');
  if (!VIETQR_ACCOUNT_RE.test(opts.account)) throw new Error('Số tài khoản không hợp lệ');
  if (!Number.isSafeInteger(opts.amount) || opts.amount <= 0 || String(opts.amount).length > 13) throw new Error('Số tiền không hợp lệ');
  const content = vietQrContent(opts.content);
  const beneficiary = tlv('00', opts.bin) + tlv('01', opts.account);
  const merchant = tlv('00', 'A000000727') + tlv('01', beneficiary) + tlv('02', 'QRIBFTTA');
  const body =
    tlv('00', '01') +
    tlv('01', '12') +
    tlv('38', merchant) +
    tlv('53', '704') +
    tlv('54', String(opts.amount)) +
    tlv('58', 'VN') +
    (content ? tlv('62', tlv('08', content)) : '') +
    '6304';
  return body + crc16(body);
}
