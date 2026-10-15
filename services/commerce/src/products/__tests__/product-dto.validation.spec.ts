import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { ListProductsQueryDto } from '../dto/list-products-query.dto';
import { buildWritableData } from '../product-write.helper';

/**
 * `ValidationPipe` cấu hình Y HỆT `main.ts` — test này chứng minh DTO CHẶN THẬT,
 * không chỉ "có decorator". Bài học repo: field chỉ có `@ApiProperty` mà thiếu
 * class-validator thì đi qua pipe không hề bị kiểm.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

const meta = (metatype: unknown): ArgumentMetadata =>
  ({ type: 'body', metatype }) as ArgumentMetadata;

const queryMeta: ArgumentMetadata = {
  type: 'query',
  metatype: ListProductsQueryDto,
} as ArgumentMetadata;

const validBody = {
  code: 'SP-500',
  name: 'Gói dịch vụ cơ bản',
  project_id: 7,
};

describe('CreateProductDto — validate thật qua ValidationPipe', () => {
  it('payload hợp lệ đi qua, transform đúng kiểu', async () => {
    const out = (await pipe.transform(
      { ...validBody, tags: ['A'], category_id: 3, description: 'Mô tả', price: 500000 },
      meta(CreateProductDto),
    )) as CreateProductDto;
    expect(out).toBeInstanceOf(CreateProductDto);
    expect(out.project_id).toBe(7);
  });

  it('project_id KHÔNG gửi vẫn hợp lệ (sản phẩm có thể không thuộc dự án)', async () => {
    const out = (await pipe.transform(
      { code: 'RETAIL-001', name: 'Áo thun' },
      meta(CreateProductDto),
    )) as CreateProductDto;
    expect(out.project_id).toBeUndefined();
  });

  it.each([
    ['thiếu code', { name: 'X', project_id: 7 }],
    ['thiếu name', { code: 'A-1', project_id: 7 }],
    ['code có ký tự lạ', { ...validBody, code: 'SP TC/500' }],
    ['code quá dài', { ...validBody, code: 'A'.repeat(65) }],
    ['project_id không phải số', { ...validBody, project_id: 'abc' }],
    ['category_id không phải số', { ...validBody, category_id: 'abc' }],
    ['price âm', { ...validBody, price: -1 }],
    ['price vượt trần', { ...validBody, price: 1_000_000_000_001 }],
    ['description vượt trần', { ...validBody, description: 'x'.repeat(2001) }],
    ['attributes không phải object', { ...validBody, attributes: 'x' }],
    ['tags không phải mảng', { ...validBody, tags: 'A' }],
    ['tags chứa số', { ...validBody, tags: [1, 2] }],
    ['tags quá nhiều phần tử', { ...validBody, tags: Array(31).fill('x') }],
    ['field lạ (forbidNonWhitelisted)', { ...validBody, hacked: true }],
  ])('%s → 400', async (_label, body) => {
    await expect(pipe.transform(body, meta(CreateProductDto))).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('UpdateProductDto — `code` / `project_id` KHÔNG sửa được', () => {
  it.each(['code', 'project_id'])('gửi %s → 400 (forbidNonWhitelisted chặn ngay tầng pipe)', async (field) => {
    await expect(
      pipe.transform({ name: 'Tên mới', [field]: field === 'code' ? 'X-1' : 999 }, meta(UpdateProductDto)),
    ).rejects.toThrow(BadRequestException);
  });

  /**
   * 🔴 — ĐO THẬT trên chính DTO này, đừng suy diễn:
   *
   * `Object.keys()` của instance dựng qua `ValidationPipe` THẬT trả ĐÚNG
   * `['is_active']` — chỉ field khai TRỰC TIẾP trong thân class mới thành own
   * property `= undefined` (target ES2022 / `useDefineForClassFields`). Field đi
   * qua mapped type `PartialType(OmitType(...))` KHÔNG sinh own property vì lớp
   * mapped chỉ copy METADATA validator, không khai lại class field.
   *
   * ⇒ Với DTO hỗn hợp (mapped type + field khai tay) `Object.keys(dto)` cho ra
   * tập key MỘT PHẦN — còn khó lần ra hơn cả ca (luôn trả ĐỦ field).
   * Vì vậy `buildWritableData` lọc `!== undefined` là bắt buộc, và tuyệt đối
   * KHÔNG được viết lại bằng `Object.keys(dto)` hay spread `...dto`: body rỗng
   * sẽ ghi `is_active: undefined` vào `data` và Prisma coi đó là "không đổi"
   * đúng lần này, nhưng vỡ ngay khi ai đó khai thêm field vào thân class.
   */
  it('body rỗng hợp lệ và KHÔNG sinh field ghi nào (khoá bất biến)', async () => {
    const out = (await pipe.transform({}, meta(UpdateProductDto))) as UpdateProductDto;
    expect(out).toBeInstanceOf(UpdateProductDto);
    expect(Object.keys(out)).toEqual(['is_active']);
    expect(out.is_active).toBeUndefined();
    // Điều DUY NHẤT phải đúng: không field nào được ghi.
    expect(buildWritableData(out)).toEqual({});
  });

  it('gửi 1 field → chỉ field đó được ghi, kể cả khi instance mang own property undefined', async () => {
    const out = (await pipe.transform({ name: 'Tên mới' }, meta(UpdateProductDto))) as UpdateProductDto;
    expect(buildWritableData(out)).toEqual({ name: 'Tên mới' });
  });

  it('is_active=false đi qua được (dùng để tắt/bật lại sản phẩm)', async () => {
    const out = (await pipe.transform({ is_active: false }, meta(UpdateProductDto))) as UpdateProductDto;
    expect(out.is_active).toBe(false);
    expect(buildWritableData(out)).toEqual({ is_active: false });
  });
});

describe('ListProductsQueryDto — query param tới dưới dạng STRING', () => {
  it('project_id "7" → number 7 (ValidationPipe KHÔNG bật implicit conversion)', async () => {
    const out = (await pipe.transform({ project_id: '7' }, queryMeta)) as ListProductsQueryDto;
    expect(out.project_id).toBe(7);
  });

  it('category_id "3" → number 3', async () => {
    const out = (await pipe.transform({ category_id: '3' }, queryMeta)) as ListProductsQueryDto;
    expect(out.category_id).toBe(3);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('is_active "%s" → boolean %s', async (raw, expected) => {
    const out = (await pipe.transform({ is_active: raw }, queryMeta)) as ListProductsQueryDto;
    expect(out.is_active).toBe(expected);
  });

  it('is_active "1" (không phải true/false) → 400 chứ không âm thầm hoá true', async () => {
    await expect(pipe.transform({ is_active: '1' }, queryMeta)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('q được trim', async () => {
    const out = (await pipe.transform({ q: '  acme  ' }, queryMeta)) as ListProductsQueryDto;
    expect(out.q).toBe('acme');
  });

  it('query rỗng hợp lệ', async () => {
    await expect(pipe.transform({}, queryMeta)).resolves.toBeDefined();
  });
});
