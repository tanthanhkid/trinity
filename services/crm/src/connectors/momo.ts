import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * MoMo cổng thanh toán (API v2, captureWallet) — https://developers.momo.vn/v3/docs/payment/api/wallet/onetime
 * Ký HMAC-SHA256 (hex) bằng secretKey trên chuỗi `k=v&…` theo ĐÚNG thứ tự trường của tài liệu.
 * IPN: MoMo POST JSON về ipnUrl; máy chủ trả HTTP 204.
 */
export const MOMO_URLS = {
  sandbox: 'https://test-payment.momo.vn/v2/gateway/api/create',
  production: 'https://payment.momo.vn/v2/gateway/api/create',
} as const;

const hmac = (secret: string, raw: string) => createHmac('sha256', secret).update(raw).digest('hex');

export interface MomoCreateInput {
  partnerCode: string;
  accessKey: string;
  secretKey: string;
  amount: number;
  orderId: string;
  requestId: string;
  orderInfo: string;
  redirectUrl: string;
  ipnUrl: string;
  extraData?: string;
}

export function momoCreateRaw(i: MomoCreateInput): string {
  return (
    `accessKey=${i.accessKey}&amount=${Math.round(i.amount)}&extraData=${i.extraData ?? ''}&ipnUrl=${i.ipnUrl}` +
    `&orderId=${i.orderId}&orderInfo=${i.orderInfo}&partnerCode=${i.partnerCode}&redirectUrl=${i.redirectUrl}` +
    `&requestId=${i.requestId}&requestType=captureWallet`
  );
}

export function momoCreateBody(i: MomoCreateInput): Record<string, unknown> {
  return {
    partnerCode: i.partnerCode,
    requestId: i.requestId,
    amount: Math.round(i.amount),
    orderId: i.orderId,
    orderInfo: i.orderInfo,
    redirectUrl: i.redirectUrl,
    ipnUrl: i.ipnUrl,
    requestType: 'captureWallet',
    extraData: i.extraData ?? '',
    lang: 'vi',
    signature: hmac(i.secretKey, momoCreateRaw(i)),
  };
}

/** Trường IPN/redirect MoMo gửi về (đúng tên trong tài liệu). */
export interface MomoResult {
  partnerCode: string;
  orderId: string;
  requestId: string;
  amount: number | string;
  orderInfo: string;
  orderType: string;
  transId: number | string;
  resultCode: number | string;
  message: string;
  payType: string;
  responseTime: number | string;
  extraData: string;
  signature: string;
}

export function momoResultRaw(r: MomoResult, accessKey: string): string {
  return (
    `accessKey=${accessKey}&amount=${r.amount}&extraData=${r.extraData ?? ''}&message=${r.message}&orderId=${r.orderId}` +
    `&orderInfo=${r.orderInfo}&orderType=${r.orderType}&partnerCode=${r.partnerCode}&payType=${r.payType}` +
    `&requestId=${r.requestId}&responseTime=${r.responseTime}&resultCode=${r.resultCode}&transId=${r.transId}`
  );
}

export function signMomoResult(r: Omit<MomoResult, 'signature'>, accessKey: string, secretKey: string): string {
  return hmac(secretKey, momoResultRaw({ ...r, signature: '' }, accessKey));
}

export function verifyMomoResult(r: MomoResult, accessKey: string, secretKey: string): boolean {
  const got = String(r?.signature ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(got) || !secretKey) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(hmac(secretKey, momoResultRaw(r, accessKey))));
}
