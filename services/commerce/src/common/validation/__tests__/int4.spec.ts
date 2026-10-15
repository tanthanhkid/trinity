/**
 * `ParseInt4Pipe` chặn trần INT4 ở PATH PARAM (`@Param`), cùng lớp lỗi với DTO
 * field nhưng KHÁC cơ chế: DTO đi qua `ValidationPipe` (class-validator), còn `@Param`
 * đi qua 1 `PipeTransform` riêng — `ParseIntPipe` gốc không có trần INT4 nên
 * `GET /products/99999999999` lọt qua rồi vỡ ở Prisma (500) thay vì 400.
 */
import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';
import { INT4_MAX, ParseInt4Pipe } from '../int4';

describe('ParseInt4Pipe — trần INT4 cho @Param (products/, pos/)', () => {
  const pipe = new ParseInt4Pipe();
  const meta: ArgumentMetadata = { type: 'param', data: 'id' };

  it('id vượt INT4_MAX → 400 (BadRequestException), KHÔNG lọt xuống Prisma', async () => {
    await expect(pipe.transform(String(INT4_MAX + 1), meta)).rejects.toThrow(
      BadRequestException,
    );
    await expect(pipe.transform(String(INT4_MAX + 1), meta)).rejects.toThrow(/32-bit/);
  });

  it('id ĐÚNG BẰNG INT4_MAX → qua bình thường', async () => {
    await expect(pipe.transform(String(INT4_MAX), meta)).resolves.toBe(INT4_MAX);
  });

  it('id hợp lệ nhỏ (vd 1) → vẫn chạy đúng như ParseIntPipe gốc', async () => {
    await expect(pipe.transform('1', meta)).resolves.toBe(1);
  });

  it('id 0 hoặc âm → 400 (id thật bắt đầu từ 1, KHÔNG hợp lệ)', async () => {
    await expect(pipe.transform('0', meta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform('-5', meta)).rejects.toThrow(BadRequestException);
  });

  it('id không phải số → vẫn 400 từ ParseIntPipe gốc (super.transform ném trước)', async () => {
    await expect(pipe.transform('abc', meta)).rejects.toThrow(BadRequestException);
  });

  it('message nêu đúng tên field từ ArgumentMetadata.data', async () => {
    const userMeta: ArgumentMetadata = { type: 'param', data: 'userId' };
    await expect(pipe.transform(String(INT4_MAX + 1), userMeta)).rejects.toThrow(
      /userId/,
    );
  });
});
