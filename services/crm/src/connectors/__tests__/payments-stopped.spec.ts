import 'reflect-metadata';
import { GoneException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { PrismaService } from '@trinity/prisma';
import { ConnectorsService } from '../connectors.service';
import { OrgFeaturesService } from '../../settings/org-features.service';
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
  const ctrl = new (ConnectorsController as unknown as new (...a: unknown[]) => ConnectorsController)(connectors, payments, {});
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

describe('POST /payments qua HTTP (#105)', () => {
  let app: INestApplication;
  let url: string;
  const features = { isEnabled: jest.fn().mockResolvedValue(false) };
  beforeAll(async () => {
    const stub = {};
    const mod = await Test.createTestingModule({
      controllers: [ConnectorsController],
      providers: [
        { provide: ConnectorsService, useValue: stub },
        { provide: PaymentsService, useValue: stub },
        { provide: OrgFeaturesService, useValue: features },
        { provide: PrismaService, useValue: stub },
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/payments`;
  });
  afterAll(() => app.close());

  it('mọi caller (không đăng nhập, tính năng thanh toán đang tắt) nhận 410 + câu ngừng tạo', async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 150000 }) });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ statusCode: 410, message: PAYMENT_CREATION_STOPPED });
    expect(features.isEnabled).not.toHaveBeenCalled();
  });
});
