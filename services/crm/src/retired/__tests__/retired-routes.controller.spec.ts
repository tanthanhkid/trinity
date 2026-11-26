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
});
