import { GoneException } from '@nestjs/common';
import { vnpaySign } from '../vnpay';
import { PaymentsService } from '../payments.service';
import { ConnectorsController, PAYMENT_CREATION_STOPPED } from '../connectors.controller';

/** G07a (#105): ngừng tạo yêu cầu thanh toán mới; IPN của yêu cầu đang chờ VẪN đánh dấu đã trả. */
const VN_SECRET = 'SECRETKEY123456789'; // gitleaks:allow — khoá giả cho test

function controller() {
  const intent = { id: 7, code: 'TRN7K2QXM', amount: 150000n, status: 'pending', source_type: 'manual', source_id: null, contact_id: null, created_by: 1 };
  const prisma = {
    connectorEvent: { create: jest.fn().mockResolvedValue({ id: 1 }), update: jest.fn().mockResolvedValue({}) },
    paymentIntent: { findUnique: jest.fn().mockResolvedValue(intent), updateMany: jest.fn().mockResolvedValue({ count: 1 }), create: jest.fn() },
    integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (db: unknown) => unknown) => fn(prisma));
  const connectors = { touch: jest.fn(), active: jest.fn().mockResolvedValue({ credentials: { hash_secret: VN_SECRET }, settings: { tmn_code: 'TESTTMN1', sandbox: true } }) };
  const payments = new PaymentsService(prisma as never, connectors as never, { ownerIds: jest.fn() } as never);
  const ctrl = new (ConnectorsController as unknown as new (...a: unknown[]) => ConnectorsController)(connectors, payments, ...Array(9).fill({}));
  return { ctrl, prisma };
}

describe('Ngừng tạo yêu cầu thanh toán mới (#105)', () => {
  it('POST /payments ⇒ 410 với câu lỗi rõ, không ghi gì', () => {
    const { ctrl, prisma } = controller();
    let err: unknown;
    try {
      (ctrl as unknown as { create(): never }).create();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GoneException);
    expect((err as GoneException).getStatus()).toBe(410);
    expect((err as GoneException).message).toBe(PAYMENT_CREATION_STOPPED);
    expect(prisma.paymentIntent.create).not.toHaveBeenCalled();
  });

  it('IPN VNPay mẫu cho yêu cầu đang chờ vẫn đánh dấu đã trả', async () => {
    const { ctrl, prisma } = controller();
    const q = { vnp_TmnCode: 'TESTTMN1', vnp_Amount: '15000000', vnp_TxnRef: 'TRN7K2QXM-ABC', vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: '14123456', vnp_PayDate: '20261015083500' };
    await expect(ctrl.vnpayIpn({ ...q, vnp_SecureHash: vnpaySign(q, VN_SECRET) })).resolves.toEqual({ RspCode: '00', Message: 'Confirm Success' });
    expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'paid' }) }));
  });
});
