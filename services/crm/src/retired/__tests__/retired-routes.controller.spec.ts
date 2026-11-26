import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { RetiredRoutesController } from '../retired-routes.controller';

describe('đường công khai của tính năng đã gỡ', () => {
  it('callback OAuth Google trả 410 kèm câu rõ', () => {
    let err: unknown;
    try {
      new RetiredRoutesController().googleOAuthCallback();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(410);
    expect(JSON.stringify((err as HttpException).getResponse())).toContain('Google Sheets');
  });

  it.each([
    ['salesWebhook', 'phần mềm bán hàng'],
    ['marketplacePush', 'sàn thương mại điện tử'],
    ['marketplaceCallback', 'sàn thương mại điện tử'],
  ] as const)('G06: %s trả 410', (method, text) => {
    let err: unknown;
    try {
      (new RetiredRoutesController() as unknown as Record<string, () => never>)[method]();
    } catch (e) {
      err = e;
    }
    expect((err as HttpException).getStatus()).toBe(410);
    expect(JSON.stringify((err as HttpException).getResponse())).toContain(text);
  });
});

describe('G07b: cổng thanh toán đã gỡ', () => {
  it.each([
    ['sepayWebhook', 'SePay'],
    ['vnpayIpn', 'VNPay'],
    ['vnpayReturn', 'VNPay'],
    ['vnpayLink', 'VNPay'],
    ['momoIpn', 'MoMo'],
    ['momoReturn', 'MoMo'],
    ['momoLink', 'MoMo'],
    ['createPayment', 'thanh toán'],
  ] as const)('%s trả 410', (method, text) => {
    let err: unknown;
    try {
      (new RetiredRoutesController() as unknown as Record<string, () => never>)[method]();
    } catch (e) {
      err = e;
    }
    expect((err as HttpException).getStatus()).toBe(410);
    expect(JSON.stringify((err as HttpException).getResponse())).toContain(text);
  });
});
