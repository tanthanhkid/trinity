import { timingSafeEqual } from 'node:crypto';

/**
 * SePay (sepay.vn) — báo biến động số dư tài khoản ngân hàng qua webhook.
 * Tài liệu: https://docs.sepay.vn/tich-hop-webhooks.html — xác thực kiểu "API Key": SePay gửi header
 * `Authorization: Apikey <khoá>`; khoá do Trinity sinh, khách dán vào cấu hình webhook trên my.sepay.vn.
 * SePay coi webhook thành công khi nhận HTTP 200/201 kèm `{"success": true}`.
 */

/** Payload webhook của SePay (đúng tên trường theo tài liệu). */
export interface SepayTransaction {
  id: number;
  gateway: string;
  transactionDate: string;
  accountNumber: string;
  code: string | null;
  content: string;
  transferType: 'in' | 'out';
  transferAmount: number;
  accumulated: number;
  subAccount: string | null;
  referenceCode: string;
  description: string;
}

/** So khoá trong header với khoá đã lưu — thời gian hằng, chấp nhận "Apikey"/"ApiKey" và khoảng trắng thừa. */
export function verifySepayAuth(header: string | undefined, expected: string): boolean {
  if (!header || !expected) return false;
  const m = /^\s*apikey\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Kiểm & chuẩn hoá payload; sai dạng ⇒ null (bỏ qua, không lưu). */
export function parseSepayTransaction(body: unknown): SepayTransaction | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const id = Number(b.id);
  const amount = Number(b.transferAmount);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (b.transferType !== 'in' && b.transferType !== 'out') return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
  return {
    id,
    gateway: str(b.gateway, 60),
    transactionDate: str(b.transactionDate, 40),
    accountNumber: str(b.accountNumber, 40),
    code: b.code == null || b.code === '' ? null : str(b.code, 60),
    content: str(b.content, 500),
    transferType: b.transferType,
    transferAmount: Math.round(amount),
    accumulated: Number(b.accumulated) || 0,
    subAccount: b.subAccount == null || b.subAccount === '' ? null : str(b.subAccount, 40),
    referenceCode: str(b.referenceCode, 100),
    description: str(b.description, 500),
  };
}

/** Giờ giao dịch SePay ("2023-03-25 14:02:37", giờ Việt Nam) → Date; không đọc được ⇒ null. */
export function sepayDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Mã thanh toán có trong giao dịch: ưu tiên `code` SePay đã tách (khi khách khai tiền tố mã trên SePay),
 * rồi tìm trong nội dung. Ngân hàng hay bỏ dấu cách/gạch hoặc chèn chữ, nên so trên chuỗi chỉ còn chữ-số viết hoa.
 */
export function findPaymentCodes(tx: Pick<SepayTransaction, 'code' | 'content' | 'description'>, prefix: string | string[]): string[] {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const out = new Set<string>();
  // `code` SePay đã tách: tin nguyên (yêu cầu nào có đúng mã đó thì khớp), không đòi tiền tố hiện tại.
  if (tx.code && norm(tx.code).length >= 4) out.add(norm(tx.code));
  for (const p of (Array.isArray(prefix) ? prefix : [prefix]).map(norm).filter((x) => /^[A-Z]{2,5}$/.test(x))) {
    const re = new RegExp(`${p}[A-Z0-9]{${PAYMENT_CODE_BODY}}`, 'g');
    for (const src of [tx.content, tx.description]) for (const m of norm(src ?? '').matchAll(re)) out.add(m[0]);
  }
  return [...out];
}

/** Số ký tự sau tiền tố của mã thanh toán (vd TRN + 6 = "TRN7K2QXM"). */
export const PAYMENT_CODE_BODY = 6;

/** Link ảnh QR VietQR của SePay — khách quét là điền sẵn số tiền + nội dung. https://qr.sepay.vn */
export function sepayQrUrl(opts: { accountNumber: string; bank: string; amount: number; content: string }): string {
  const q = new URLSearchParams({ acc: opts.accountNumber, bank: opts.bank, amount: String(opts.amount), des: opts.content });
  return `https://qr.sepay.vn/img?${q.toString()}`;
}
