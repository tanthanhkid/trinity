import { BadRequestException, ParseIntPipe, type ArgumentMetadata } from '@nestjs/common';

/**
 * Trần INT4 của Postgres cho MỌI field DTO trỏ tới cột `Int` (id, cursor, fk).
 *
 * Vì sao phải có (đo bằng chính `ValidationPipe`): `?cursor=99999999999`
 * đi qua `@IsInt` + `@Min` nguyên vẹn rồi vỡ ở Prisma ("Unable to fit integer value
 * into an INT4") → **500** thay vì **400**. Nếu hằng này nằm trong một DTO
 * riêng của một module khác ⇒ import vòng ⇒ hằng `undefined` lúc
 * decorator chạy ⇒ `@Max(undefined)` bỏ qua im lặng. Đặt ở `common/` để mọi module
 * (`products`, `pos`, ...) dùng chung mà không có cạnh vòng.
 */
export const INT4_MAX = 2_147_483_647;
export const INT4_MSG = 'vượt giới hạn số nguyên 32-bit';

/**
 * `ParseIntPipe` KHÔNG chặn trần INT4 — cùng lớp lỗi với hằng số trên nhưng ở
 * PATH PARAM (`:id`/`:userId`) thay vì field DTO. `GET /products/99999999999`
 * qua `ParseIntPipe` nguyên vẹn rồi vỡ ở Prisma ("Unable to fit integer value
 * into an INT4") → 500 thay vì 400.
 *
 * Dùng cho MỌI `@Param` trỏ tới cột `Int` (id, fk) của module `products/`, `pos/`.
 */
export class ParseInt4Pipe extends ParseIntPipe {
  async transform(value: string, metadata: ArgumentMetadata): Promise<number> {
    const n = await super.transform(value, metadata);
    if (n > INT4_MAX || n < 1) {
      throw new BadRequestException(`${String(metadata.data ?? 'id')} ${INT4_MSG}`);
    }
    return n;
  }
}
