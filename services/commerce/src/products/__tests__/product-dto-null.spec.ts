import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { buildWritableData } from '../product-write.helper';

/**
 * Review — `null` qua `@IsOptional()`.
 *
 * `@IsOptional()` của class-validator bỏ qua CẢ `null` LẪN `undefined`, nên body
 * `{ brand: null }` đi qua `ValidationPipe` nguyên vẹn. Bản trước review:
 * `buildWritableData` chỉ lọc `!== undefined` rồi gọi `new Prisma.Decimal(null)` /
 * `BigInt(null)` → ném lỗi runtime = **500**; `{ name: null }`/`{ tags: null }` lọt tới
 * Prisma trên cột NOT NULL → cũng 500. Đo thật bằng chính pipe cấu hình như `main.ts`.
 *
 * Ranh giới sau sửa:
 *  - cột NULLABLE: `null` = xoá giá trị → helper ghi `null`;
 *  - cột NOT NULL: `null` → 400 ngay tầng pipe (`ValidateIf(isDefined)` + `skipNullProperties:false`).
 *
 * Bộ test dùng các field `category_id`/`description`/`price`.
 * `project_id` giữ NULLABLE ở `CreateProductDto` (optional) nhưng
 * `UpdateProductDto` KHÔNG có field này (immutable sau tạo, OmitType) — 2 DTO
 * test RIÊNG, không dùng chung 1 mảng NULLABLE_BODIES cho field đó.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = (metatype: unknown): ArgumentMetadata =>
  ({ type: 'body', metatype }) as ArgumentMetadata;

const validCreate = { code: 'SP-500', name: 'Gói dịch vụ cơ bản', project_id: 7 };

/** Field nullable CÓ trong CẢ 2 DTO (create + update). */
const NULLABLE_BODIES: Array<[string, Record<string, null>]> = [
  ['brand', { brand: null }],
  ['color', { color: null }],
  ['image_url', { image_url: null }],
  ['category_id', { category_id: null }],
  ['description', { description: null }],
  ['price', { price: null }],
];

const NOT_NULL_UPDATE_BODIES: Array<[string, Record<string, null>]> = [
  ['name', { name: null }],
  ['tags', { tags: null }],
  ['is_featured', { is_featured: null }],
  ['is_active', { is_active: null }],
];

describe('UpdateProductDto — null', () => {
  it.each(NULLABLE_BODIES)(
    'cột nullable %s = null → đi qua pipe, buildWritableData ghi null (không ném BigInt error)',
    async (_field, body) => {
      const out = (await pipe.transform(body, meta(UpdateProductDto))) as UpdateProductDto;
      expect(() => buildWritableData(out)).not.toThrow();
      expect(buildWritableData(out)).toEqual(body);
    },
  );

  it.each(NOT_NULL_UPDATE_BODIES)('cột NOT NULL %s = null → 400 tại pipe, không lọt tới Prisma', async (_f, body) => {
    await expect(pipe.transform(body, meta(UpdateProductDto))).rejects.toThrow(BadRequestException);
  });

  it('`project_id: null` bị 400 (field KHÔNG có trong UpdateProductDto, forbidNonWhitelisted)', async () => {
    await expect(
      pipe.transform({ project_id: null }, meta(UpdateProductDto)),
    ).rejects.toThrow(BadRequestException);
  });

  it('xoá category_id (bỏ phân loại) + giữ field khác trong cùng 1 body', async () => {
    const out = (await pipe.transform(
      { name: 'Tên mới', category_id: null },
      meta(UpdateProductDto),
    )) as UpdateProductDto;
    expect(buildWritableData(out)).toEqual({ name: 'Tên mới', category_id: null });
  });

  it('khoá bất biến sau khi đổi skipNullProperties: instance rỗng vẫn chỉ có own-key is_active', async () => {
    const out = (await pipe.transform({}, meta(UpdateProductDto))) as UpdateProductDto;
    expect(Object.keys(out)).toEqual(['is_active']);
    expect(buildWritableData(out)).toEqual({});
  });
});

describe('CreateProductDto — null', () => {
  it.each(NULLABLE_BODIES)('cột nullable %s = null → đi qua, data ghi null', async (_field, body) => {
    const out = (await pipe.transform({ ...validCreate, ...body }, meta(CreateProductDto))) as CreateProductDto;
    expect(() => buildWritableData(out)).not.toThrow();
    expect(buildWritableData(out)).toEqual({ name: validCreate.name, ...body });
  });

  /**
   * `project_id` KHÔNG đi qua `buildWritableData` dù ở `CreateProductDto`
   * xem docblock hàm đó: `ProductsService.create()` set field này TRỰC TIẾP
   * (`dto.project_id ?? null`) để `buildWritableData` KHÔNG BAO GIỜ ghi được
   * `project_id`, kể cả khi có người ép kiểu 1 object thô mang key đó vào
   * `UpdateProductDto` (test ở `products.service.spec.ts` khoá bất biến này).
   */
  it('project_id = null hợp lệ ở tầng DTO (sản phẩm không thuộc dự án nào)', async () => {
    const out = (await pipe.transform(
      { code: validCreate.code, name: validCreate.name, project_id: null },
      meta(CreateProductDto),
    )) as CreateProductDto;
    expect(out.project_id).toBeNull();
    expect(buildWritableData(out)).toEqual({ name: validCreate.name });
  });

  it.each(['tags', 'is_featured'])(
    'cột NOT NULL %s = null → 400 (không dựa vào DEFAULT của DB)',
    async (field) => {
      await expect(
        pipe.transform({ ...validCreate, [field]: null }, meta(CreateProductDto)),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it('field bắt buộc code/name = null → 400', async () => {
    for (const field of ['code', 'name']) {
      await expect(
        pipe.transform({ ...validCreate, [field]: null }, meta(CreateProductDto)),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('không gửi field nào ngoài 3 field bắt buộc → data chỉ có name (project_id do service.create() set riêng)', async () => {
    const out = (await pipe.transform(validCreate, meta(CreateProductDto))) as CreateProductDto;
    expect(buildWritableData(out)).toEqual({ name: validCreate.name });
  });
});
