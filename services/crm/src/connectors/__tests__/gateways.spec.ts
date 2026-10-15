import { vnpayPayUrl, vnpaySign, vnpaySignData, verifyVnpay, vnpayDate, asciiInfo, codeFromTxnRef, txnRefFor } from '../vnpay';
import { momoCreateBody, momoCreateRaw, signMomoResult, verifyMomoResult, type MomoResult } from '../momo';
import { PaymentsService } from '../payments.service';

/** Bộ tham số + chữ ký tham chiếu tính độc lập bằng Python (urllib.parse.quote_plus + hmac sha512), theo đặc tả VNPay 2.1.0. */
const VN_PARAMS: Record<string, string> = {
  vnp_Version: '2.1.0', vnp_Command: 'pay', vnp_TmnCode: 'TESTTMN1', vnp_Amount: '15000000', vnp_CurrCode: 'VND',
  vnp_TxnRef: 'TRN7K2QXM-ABC', vnp_OrderInfo: 'Thanh toan TRN7K2QXM Hoc phi', vnp_OrderType: 'other', vnp_Locale: 'vn',
  vnp_ReturnUrl: 'https://crm.example.com/api/v1/pay/vnpay/return', vnp_IpAddr: '1.2.3.4', vnp_CreateDate: '20261015083000', vnp_ExpireDate: '20261015084500',
};
const VN_SECRET = 'SECRETKEY123456789'; // gitleaks:allow — khoá giả cho test
const VN_REF_HASH = '98af5970cfc059d0233e995f7cc863ae814ce1a6811b79b0b2da18352354821028b989ded4289feae2093e3003dc48fa80054ddb696d3b2fe4277ec6d9aec431';

describe('VNPay — ký theo đặc tả 2.1.0', () => {
  it('chuỗi ký sắp xếp + mã hoá dấu cách thành "+" như tài liệu', () => {
    expect(vnpaySignData(VN_PARAMS)).toBe(
      'vnp_Amount=15000000&vnp_Command=pay&vnp_CreateDate=20261015083000&vnp_CurrCode=VND&vnp_ExpireDate=20261015084500&vnp_IpAddr=1.2.3.4&vnp_Locale=vn' +
        '&vnp_OrderInfo=Thanh+toan+TRN7K2QXM+Hoc+phi&vnp_OrderType=other&vnp_ReturnUrl=https%3A%2F%2Fcrm.example.com%2Fapi%2Fv1%2Fpay%2Fvnpay%2Freturn' +
        '&vnp_TmnCode=TESTTMN1&vnp_TxnRef=TRN7K2QXM-ABC&vnp_Version=2.1.0',
    );
  });

  it('HMAC-SHA512 khớp bản tính độc lập', () => {
    expect(vnpaySign(VN_PARAMS, VN_SECRET)).toBe(VN_REF_HASH);
  });

  it('kiểm IPN: đúng chữ ký thì nhận, sửa một trường thì từ chối', () => {
    const ipn = { ...VN_PARAMS, vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: '14123456' };
    const signed = { ...ipn, vnp_SecureHashType: 'HmacSHA512', vnp_SecureHash: vnpaySign(ipn, VN_SECRET) };
    expect(verifyVnpay(signed, VN_SECRET)).toBe(true);
    expect(verifyVnpay({ ...signed, vnp_Amount: '100' }, VN_SECRET)).toBe(false);
    expect(verifyVnpay({ ...signed, vnp_SecureHash: 'abc' }, VN_SECRET)).toBe(false);
  });

  it('URL thanh toán: sandbox, số tiền ×100, giờ GMT+7, thông tin không dấu', () => {
    const url = new URL(vnpayPayUrl({ tmnCode: 'TESTTMN1', secret: VN_SECRET, sandbox: true, amount: 150000, txnRef: 'TRN7K2QXM-A', orderInfo: 'Thanh toán học phí — bé An', returnUrl: 'https://x/r', ipAddr: '1.2.3.4', now: new Date('2026-10-15T01:30:00Z') }));
    expect(url.origin + url.pathname).toBe('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html');
    expect(url.searchParams.get('vnp_Amount')).toBe('15000000');
    expect(url.searchParams.get('vnp_CreateDate')).toBe('20261015083000');
    expect(url.searchParams.get('vnp_ExpireDate')).toBe('20261015084500');
    expect(url.searchParams.get('vnp_OrderInfo')).toBe('Thanh toan hoc phi be An');
    const params = Object.fromEntries(url.searchParams.entries());
    expect(verifyVnpay(params, VN_SECRET)).toBe(true);
  });

  it('hàm phụ', () => {
    expect(vnpayDate(new Date('2026-12-31T17:00:00Z'))).toBe('20270101000000');
    expect(asciiInfo('Đơn hàng #12 — Sữa')).toBe('Don hang 12 Sua');
    expect(codeFromTxnRef(txnRefFor('TRN7K2QXM', 123456))).toBe('TRN7K2QXM');
  });
});

/** Khoá giả cho test (không phải khoá MoMo thật). */
const K = { partnerCode: 'MOMO', accessKey: 'TESTACCESS01', secretKey: 'test-only-not-a-real-key' }; // gitleaks:allow

describe('MoMo — ký theo tài liệu v2', () => {
  const input = { partnerCode: K.partnerCode, accessKey: K.accessKey, secretKey: K.secretKey, amount: 10000, orderId: 'TRN7K2QXM-A', requestId: 'TRN7K2QXM-A', orderInfo: 'Thanh toán', redirectUrl: 'https://x/r', ipnUrl: 'https://x/i' };
  it('chuỗi ký tạo giao dịch đúng thứ tự trường', () => {
    expect(momoCreateRaw(input)).toBe(
      'accessKey=TESTACCESS01&amount=10000&extraData=&ipnUrl=https://x/i&orderId=TRN7K2QXM-A&orderInfo=Thanh toán&partnerCode=MOMO&redirectUrl=https://x/r&requestId=TRN7K2QXM-A&requestType=captureWallet',
    );
    const body = momoCreateBody(input);
    expect(body).toMatchObject({ requestType: 'captureWallet', amount: 10000, lang: 'vi' });
    expect(body.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('kiểm IPN: đúng chữ ký thì nhận, sửa số tiền thì từ chối', () => {
    const r: Omit<MomoResult, 'signature'> = { partnerCode: 'MOMO', orderId: 'TRN7K2QXM-A', requestId: 'TRN7K2QXM-A', amount: 10000, orderInfo: 'Thanh toán', orderType: 'momo_wallet', transId: 4088878653, resultCode: 0, message: 'Thành công.', payType: 'qr', responseTime: 1721720663942, extraData: '' };
    const signed = { ...r, signature: signMomoResult(r, K.accessKey, K.secretKey) };
    expect(verifyMomoResult(signed, K.accessKey, K.secretKey)).toBe(true);
    expect(verifyMomoResult({ ...signed, amount: 1 }, K.accessKey, K.secretKey)).toBe(false);
  });
});

describe('PaymentsService — IPN cổng', () => {
  const intent = { id: 7, code: 'TRN7K2QXM', amount: 150000n, status: 'pending', source_type: 'manual', source_id: null, contact_id: null, created_by: 1 };
  function setup(conn: object | null, found: object | null = intent) {
    const prisma = {
      connectorEvent: { create: jest.fn().mockResolvedValue({ id: 1 }), update: jest.fn().mockResolvedValue({}) },
      paymentIntent: { findUnique: jest.fn().mockResolvedValue(found), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (db: unknown) => unknown) => fn(prisma));
    const connectors = { touch: jest.fn(), active: jest.fn().mockResolvedValue(conn) };
    return { prisma, svc: new PaymentsService(prisma as never, connectors as never, { ownerIds: jest.fn() } as never) };
  }
  const vnConn = { credentials: { hash_secret: VN_SECRET }, settings: { tmn_code: 'TESTTMN1', sandbox: true } };
  const ipn = (over: Record<string, string> = {}) => {
    const q = { vnp_TmnCode: 'TESTTMN1', vnp_Amount: '15000000', vnp_TxnRef: 'TRN7K2QXM-ABC', vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: '14123456', vnp_PayDate: '20261015083500', ...over };
    return { ...q, vnp_SecureHash: vnpaySign(q, VN_SECRET) };
  };

  it('VNPay IPN hợp lệ ⇒ RspCode 00 + đã thanh toán', async () => {
    const { prisma, svc } = setup(vnConn);
    await expect(svc.handleVnpayIpn(ipn())).resolves.toEqual({ RspCode: '00', Message: 'Confirm Success' });
    expect(prisma.paymentIntent.updateMany).toHaveBeenCalled();
    expect(prisma.integrationEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ event_type: 'payment.received' }) }));
  });

  it('VNPay sai chữ ký ⇒ 97; sai số tiền ⇒ 04; không có đơn ⇒ 01', async () => {
    await expect(setup(vnConn).svc.handleVnpayIpn({ ...ipn(), vnp_Amount: '1' })).resolves.toMatchObject({ RspCode: '97' });
    await expect(setup(vnConn).svc.handleVnpayIpn(ipn({ vnp_Amount: '100' }))).resolves.toMatchObject({ RspCode: '04' });
    await expect(setup(vnConn, null).svc.handleVnpayIpn(ipn())).resolves.toMatchObject({ RspCode: '01' });
  });

  it('VNPay giao dịch thất bại ⇒ 00 (đã ghi nhận) nhưng KHÔNG đánh dấu đã trả', async () => {
    const { prisma, svc } = setup(vnConn);
    await expect(svc.handleVnpayIpn(ipn({ vnp_ResponseCode: '24', vnp_TransactionStatus: '02' }))).resolves.toMatchObject({ RspCode: '00' });
    expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
  });

  it('MoMo IPN hợp lệ ⇒ đã thanh toán; sai chữ ký ⇒ từ chối', async () => {
    const conn = { credentials: { access_key: K.accessKey, secret_key: K.secretKey }, settings: { partner_code: 'MOMO', sandbox: true } };
    const r: Omit<MomoResult, 'signature'> = { partnerCode: 'MOMO', orderId: 'TRN7K2QXM-A', requestId: 'TRN7K2QXM-A', amount: 150000, orderInfo: 'x', orderType: 'momo_wallet', transId: 1, resultCode: 0, message: 'ok', payType: 'qr', responseTime: 1, extraData: '' };
    const ok = setup(conn);
    await expect(ok.svc.handleMomoIpn({ ...r, signature: signMomoResult(r, K.accessKey, K.secretKey) })).resolves.toEqual({ status: 'paid' });
    await expect(setup(conn).svc.handleMomoIpn({ ...r, signature: '0'.repeat(64) })).resolves.toEqual({ status: 'invalid_signature' });
  });
});
