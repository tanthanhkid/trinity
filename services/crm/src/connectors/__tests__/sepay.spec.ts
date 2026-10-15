import { Prisma } from '@trinity/prisma';
import { findPaymentCodes, parseSepayTransaction, sepayDate, sepayQrUrl, verifySepayAuth } from '../sepay';
import { PaymentsService, newPaymentCode } from '../payments.service';
import { cleanSepaySettings } from '../connectors.service';

/** Payload mẫu nguyên văn trong tài liệu SePay (https://docs.sepay.vn/tich-hop-webhooks.html). */
const OFFICIAL_SAMPLE = {
  id: 92704,
  gateway: 'Vietcombank',
  transactionDate: '2023-03-25 14:02:37',
  accountNumber: '0123499999',
  code: null,
  content: 'chuyen tien mua iphone',
  transferType: 'in',
  transferAmount: 2277000,
  accumulated: 19077000,
  subAccount: null,
  referenceCode: 'MBVCB.3278907687',
  description: '',
};

describe('SePay — hàm thuần', () => {
  it('đọc đúng payload mẫu chính thức', () => {
    const tx = parseSepayTransaction(OFFICIAL_SAMPLE)!;
    expect(tx).toMatchObject({ id: 92704, transferType: 'in', transferAmount: 2277000, code: null, referenceCode: 'MBVCB.3278907687' });
    expect(sepayDate(tx.transactionDate)!.toISOString()).toBe('2023-03-25T07:02:37.000Z');
  });

  it('bỏ payload sai dạng', () => {
    expect(parseSepayTransaction(null)).toBeNull();
    expect(parseSepayTransaction({ ...OFFICIAL_SAMPLE, id: 'x' })).toBeNull();
    expect(parseSepayTransaction({ ...OFFICIAL_SAMPLE, transferType: 'sideways' })).toBeNull();
    expect(parseSepayTransaction({ ...OFFICIAL_SAMPLE, transferAmount: -5 })).toBeNull();
  });

  it('kiểm header Authorization: Apikey', () => {
    expect(verifySepayAuth('Apikey sepay_abc', 'sepay_abc')).toBe(true);
    expect(verifySepayAuth('apikey   sepay_abc ', 'sepay_abc')).toBe(true);
    expect(verifySepayAuth('Apikey sepay_abd', 'sepay_abc')).toBe(false);
    expect(verifySepayAuth('Bearer sepay_abc', 'sepay_abc')).toBe(false);
    expect(verifySepayAuth(undefined, 'sepay_abc')).toBe(false);
    expect(verifySepayAuth('Apikey ', '')).toBe(false);
  });

  it('tìm mã trong nội dung dù ngân hàng chèn chữ, bỏ khoảng trắng/gạch', () => {
    expect(findPaymentCodes({ code: null, content: 'MBVCB.123 trn-7k2qxm chuyen khoan', description: '' }, 'TRN')).toEqual(['TRN7K2QXM']);
    expect(findPaymentCodes({ code: 'TRN7K2QXM', content: 'abc', description: '' }, 'TRN')).toEqual(['TRN7K2QXM']);
    expect(findPaymentCodes({ code: null, content: 'trn7k2qxm', description: '' }, ['ABC', 'TRN'])).toEqual(['TRN7K2QXM']);
    expect(findPaymentCodes({ code: null, content: 'chuyen tien mua iphone', description: '' }, 'TRN')).toEqual([]);
  });

  it('mã sinh ra đúng dạng, không có ký tự dễ nhầm', () => {
    for (let i = 0; i < 50; i++) expect(newPaymentCode('TRN')).toMatch(/^TRN[A-HJ-NP-Z2-9]{6}$/);
  });

  it('link QR SePay', () => {
    expect(sepayQrUrl({ accountNumber: '0123499999', bank: 'Vietcombank', amount: 150000, content: 'TRN7K2QXM' })).toBe(
      'https://qr.sepay.vn/img?acc=0123499999&bank=Vietcombank&amount=150000&des=TRN7K2QXM',
    );
  });

  it('kiểm cấu hình tài khoản', () => {
    expect(cleanSepaySettings({ account_number: '0123 499 999', bank: 'MBBank' })).toEqual({ account_number: '0123499999', bank: 'MBBank', code_prefix: 'TRN' });
    expect(() => cleanSepaySettings({ account_number: '12', bank: 'MBBank' })).toThrow();
    expect(() => cleanSepaySettings({ account_number: '0123499999', bank: 'MBBank', code_prefix: 'T' })).toThrow();
  });
});

describe('PaymentsService.handleSepay — tự khớp', () => {
  const intent = { id: 7, code: 'TRN7K2QXM', amount: 2277000n, status: 'pending', source_type: 'deal', source_id: 3, contact_id: 9, created_by: 1 };
  function setup(found: object | null = intent) {
    const prisma = {
      connectorEvent: { create: jest.fn().mockResolvedValue({ id: 1 }), update: jest.fn().mockResolvedValue({}) },
      paymentIntent: { findFirst: jest.fn().mockResolvedValue(found), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    prisma.connectorEvent = { ...prisma.connectorEvent, findUnique: jest.fn().mockResolvedValue({ id: 1, status: 'matched' }) } as never;
    prisma.$transaction.mockImplementation((fn: (db: unknown) => unknown) => fn(prisma));
    const connectors = { touch: jest.fn().mockResolvedValue(undefined), active: jest.fn().mockResolvedValue(null) };
    const scope = { ownerIds: jest.fn().mockResolvedValue('all') };
    return { prisma: prisma as typeof prisma & { connectorEvent: { findUnique: jest.Mock } }, svc: new PaymentsService(prisma as never, connectors as never, scope as never), scope };
  }
  const tx = (over: object = {}) => parseSepayTransaction({ ...OFFICIAL_SAMPLE, content: 'TRN7K2QXM thanh toan', ...over })!;

  it('khớp mã + đủ tiền ⇒ đã thanh toán + phát payment.received', async () => {
    const { prisma, svc } = setup();
    await expect(svc.handleSepay(tx(), 'TRN')).resolves.toEqual({ status: 'matched', payment_intent_id: 7 });
    expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7, status: { in: ['pending', 'expired'] } } }));
    expect(prisma.integrationEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ event_type: 'payment.received' }) }));
    expect(prisma.connectorEvent.update).toHaveBeenLastCalledWith({ where: { id: 1 }, data: { status: 'matched', payment_intent_id: 7 } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('yêu cầu của đơn online (store_order) ⇒ đơn chuyển "đã thanh toán" cùng giao dịch', async () => {
    const { prisma, svc } = setup({ ...intent, source_type: 'store_order', source_id: 41 });
    (prisma as unknown as { storeOrder: { updateMany: jest.Mock } }).storeOrder = { updateMany: jest.fn() };
    await svc.handleSepay(tx(), 'TRN');
    expect((prisma as unknown as { storeOrder: { updateMany: jest.Mock } }).storeOrder.updateMany).toHaveBeenCalledWith({ where: { id: 41, status: { in: ['new', 'confirmed'] } }, data: { status: 'paid' } });
  });

  it('nhận trùng (SePay gửi lại) ⇒ không xử lý lần hai', async () => {
    const { prisma, svc } = setup();
    prisma.connectorEvent.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(svc.handleSepay(tx(), 'TRN')).resolves.toEqual({ status: 'duplicate' });
    expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
  });

  it('lần trước xử lý dở (sự kiện còn unmatched) ⇒ SePay gửi lại thì khớp tiếp', async () => {
    const { prisma, svc } = setup();
    prisma.connectorEvent.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    prisma.connectorEvent.findUnique.mockResolvedValue({ id: 5, status: 'unmatched' });
    await expect(svc.handleSepay(tx(), 'TRN')).resolves.toEqual({ status: 'matched', payment_intent_id: 7 });
    expect(prisma.connectorEvent.update).toHaveBeenLastCalledWith({ where: { id: 5 }, data: { status: 'matched', payment_intent_id: 7 } });
  });

  it('câu SQL lấy tiền tố ép kiểu ::int (Postgres không có left(varchar, bigint))', async () => {
    const { prisma, svc } = setup();
    await svc.handleSepay(tx(), 'TRN');
    const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/length\(code\) - \?::int\)/);
  });

  it('đổi tiền tố khi còn yêu cầu cũ ⇒ vẫn khớp mã tiền tố cũ', async () => {
    const { prisma, svc } = setup();
    prisma.$queryRaw.mockResolvedValue([{ p: 'TRN' }]);
    await expect(svc.handleSepay(tx(), 'ABC')).resolves.toEqual({ status: 'matched', payment_intent_id: 7 });
    expect(prisma.paymentIntent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ code: { in: ['TRN7K2QXM'] } }) }));
  });

  it('thiếu tiền ⇒ chưa đánh dấu đã trả', async () => {
    const { prisma, svc } = setup();
    await expect(svc.handleSepay(tx({ transferAmount: 1000000 }), 'TRN')).resolves.toEqual({ status: 'underpaid', payment_intent_id: 7 });
    expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
  });

  it('tiền ra / không có mã ⇒ bỏ qua / chưa khớp', async () => {
    const a = setup();
    await expect(a.svc.handleSepay(tx({ transferType: 'out' }), 'TRN')).resolves.toEqual({ status: 'ignored' });
    const b = setup();
    await expect(b.svc.handleSepay(parseSepayTransaction(OFFICIAL_SAMPLE)!, 'TRN')).resolves.toEqual({ status: 'unmatched' });
    expect(b.prisma.paymentIntent.findFirst).not.toHaveBeenCalled();
  });

  it('đã thanh toán trước đó (đua hai webhook) ⇒ không phát sự kiện lần hai', async () => {
    const { prisma, svc } = setup();
    prisma.paymentIntent.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.handleSepay(tx(), 'TRN')).resolves.toEqual({ status: 'unmatched' });
    expect(prisma.integrationEvent.create).not.toHaveBeenCalled();
  });
});

describe('PaymentsService — phân quyền theo phạm vi deal', () => {
  it('quyền "own" ⇒ chỉ thấy yêu cầu mình tạo; lọc "quá hạn" theo expires_at', async () => {
    const prisma = { paymentIntent: { findMany: jest.fn().mockResolvedValue([]) } };
    const connectors = { active: jest.fn().mockResolvedValue(null) };
    const scope = { ownerIds: jest.fn().mockResolvedValue([42]) };
    const svc = new PaymentsService(prisma as never, connectors as never, scope as never);
    await svc.list({ status: 'expired' }, { userId: 42 } as never);
    const where = prisma.paymentIntent.findMany.mock.calls[0][0].where;
    expect(where.AND[1]).toEqual({ created_by: { in: [42] } });
    expect(where.AND[0]).toMatchObject({ status: 'pending', expires_at: { lt: expect.any(Date) } });
  });

  it('huỷ yêu cầu ngoài phạm vi ⇒ 404, không đổi gì', async () => {
    const prisma = { paymentIntent: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() } };
    const svc = new PaymentsService(prisma as never, { active: jest.fn() } as never, { ownerIds: jest.fn().mockResolvedValue([1]) } as never);
    await expect(svc.cancel(9, { userId: 42 } as never)).rejects.toThrow('Không có yêu cầu thanh toán này.');
    expect(prisma.paymentIntent.updateMany).not.toHaveBeenCalled();
  });
});
