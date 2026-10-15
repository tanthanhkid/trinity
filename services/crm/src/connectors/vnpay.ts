import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * VNPay cổng thanh toán (API 2.1.0) — https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html
 * Ký: sắp xếp tham số `vnp_*` theo tên, mã hoá giá trị kiểu application/x-www-form-urlencoded (dấu cách = "+"),
 * nối `k=v&…`, rồi HMAC-SHA512 bằng `vnp_HashSecret` (hex). IPN gọi GET về máy chủ với cùng cách ký.
 */
export const VNPAY_URLS = {
  sandbox: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  production: 'https://pay.vnpay.vn/vpcpay.html',
} as const;

const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');

/** Chuỗi ký = query đã sắp xếp (không gồm vnp_SecureHash / vnp_SecureHashType). */
export function vnpaySignData(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k.startsWith('vnp_') && k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType' && params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${enc(k)}=${enc(String(params[k]))}`)
    .join('&');
}

export function vnpaySign(params: Record<string, string>, secret: string): string {
  return createHmac('sha512', secret).update(Buffer.from(vnpaySignData(params), 'utf-8')).digest('hex');
}

export function verifyVnpay(params: Record<string, string>, secret: string): boolean {
  const got = String(params.vnp_SecureHash ?? '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(got) || !secret) return false;
  const want = vnpaySign(params, secret);
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** yyyyMMddHHmmss theo giờ Việt Nam (VNPay yêu cầu GMT+7). */
export function vnpayDate(d: Date): string {
  const t = new Date(d.getTime() + 7 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

/** Bỏ dấu tiếng Việt + ký tự đặc biệt — VNPay khuyến nghị vnp_OrderInfo không dấu. */
export function asciiInfo(s: string, max = 200): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9 .,:_-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export interface VnpayPayInput {
  tmnCode: string;
  secret: string;
  sandbox: boolean;
  amount: number;
  txnRef: string;
  orderInfo: string;
  returnUrl: string;
  ipAddr: string;
  now?: Date;
  expiresInMinutes?: number;
}

export function vnpayPayUrl(i: VnpayPayInput): string {
  const now = i.now ?? new Date();
  const params: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: i.tmnCode,
    vnp_Amount: String(Math.round(i.amount) * 100),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: i.txnRef,
    vnp_OrderInfo: asciiInfo(i.orderInfo) || i.txnRef,
    vnp_OrderType: 'other',
    vnp_Locale: 'vn',
    vnp_ReturnUrl: i.returnUrl,
    vnp_IpAddr: i.ipAddr || '127.0.0.1',
    vnp_CreateDate: vnpayDate(now),
    vnp_ExpireDate: vnpayDate(new Date(now.getTime() + (i.expiresInMinutes ?? 15) * 60_000)),
  };
  const hash = vnpaySign(params, i.secret);
  return `${i.sandbox ? VNPAY_URLS.sandbox : VNPAY_URLS.production}?${vnpaySignData(params)}&vnp_SecureHash=${hash}`;
}

/** Mã phản hồi IPN theo tài liệu VNPay. */
export const VNPAY_IPN = {
  ok: { RspCode: '00', Message: 'Confirm Success' },
  notFound: { RspCode: '01', Message: 'Order not found' },
  alreadyConfirmed: { RspCode: '02', Message: 'Order already confirmed' },
  invalidAmount: { RspCode: '04', Message: 'invalid amount' },
  invalidSignature: { RspCode: '97', Message: 'Invalid signature' },
  unknown: { RspCode: '99', Message: 'Unknow error' },
} as const;

/** TxnRef = mã yêu cầu + hậu tố lần thử (VNPay không nhận lại TxnRef đã dùng) ⇒ tách lại mã yêu cầu. */
export const txnRefFor = (code: string, now = Date.now()) => `${code}-${now.toString(36).toUpperCase()}`;
export const codeFromTxnRef = (ref: string) => String(ref ?? '').split('-')[0].toUpperCase();
