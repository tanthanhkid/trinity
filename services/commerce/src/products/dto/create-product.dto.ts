import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  IsArray,
  IsObject,
  ArrayMaxSize,
  MaxLength,
  MinLength,
  Matches,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { INT4_MAX, INT4_MSG } from '../../common/validation/int4';

/** Trần phần tử cho mảng `tags` — chặn payload phình vô hạn (bảng nhỏ, không cần hơn). */
export const PRODUCT_LIST_MAX_ITEMS = 30;
/** Trần độ dài 1 tag. */
export const PRODUCT_LIST_ITEM_MAX_LENGTH = 255;
/**
 * Trần số tiền (VND) cho `price`. 1.000 tỷ VND, dưới
 * `Number.MAX_SAFE_INTEGER` (9,007e15) để `Number(BigInt)` lúc trả JSON KHÔNG
 * mất chính xác.
 */
export const PRODUCT_PRICE_CEILING = 1_000_000_000_000;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 2000;

/**
 * Dùng cho field TUỲ CHỌN nhưng cột DB là NOT NULL (`tags`/`is_featured`, và
 * `is_active` ở UpdateProductDto): `undefined` (không gửi) được bỏ qua như
 * `@IsOptional()`, nhưng `null` PHẢI chạy validator gốc và bị 400.
 * `@IsOptional()` của class-validator bỏ qua CẢ `null` — để `null` lọt tới
 * Prisma trên cột NOT NULL là 500 (PrismaClientValidationError), không phải 400.
 * Với cột NULLABLE thì ngược lại: giữ `@IsOptional()` để `null` đi qua = "xoá
 * giá trị", helper ghi `null` thật.
 */
export const isDefined = (_obj: unknown, value: unknown): boolean => value !== undefined;

/**
 * Khung khai báo sản phẩm chung đa ngành: `category_id` + `attributes` (thuộc tính
 * động theo `ProductAttributeDef` của danh mục — BE validate bằng
 * `validateProductAttributes()`, KHÔNG hardcode field theo ngành).
 */
export class CreateProductDto {
  @ApiProperty({ example: 'SP-500', description: 'Mã sản phẩm — UNIQUE, KHÔNG đổi được sau khi tạo.' })
  @IsString({ message: 'code phải là chuỗi' })
  @MinLength(2, { message: 'Mã sản phẩm tối thiểu 2 ký tự' })
  @MaxLength(64, { message: 'Mã sản phẩm tối đa 64 ký tự' })
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'Mã sản phẩm chỉ chứa chữ, số, gạch ngang và gạch dưới',
  })
  code!: string;

  @ApiProperty({ example: 'Gói dịch vụ cơ bản' })
  @IsString({ message: 'name phải là chuỗi' })
  @MinLength(2, { message: 'Tên sản phẩm tối thiểu 2 ký tự' })
  @MaxLength(255, { message: 'Tên sản phẩm tối đa 255 ký tự' })
  name!: string;

  @ApiPropertyOptional({
    example: 12,
    description:
      'Dự án chứa sản phẩm (OPTIONAL — sản phẩm có thể không thuộc dự án nào). Có gửi thì PHẢI tồn tại và đang hoạt động.',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'project_id phải là số nguyên' })
  @Min(1, { message: 'project_id không hợp lệ' })
  @Max(INT4_MAX, { message: `project_id ${INT4_MSG}` })
  project_id?: number | null;

  @ApiPropertyOptional({
    example: 3,
    description: 'Danh mục/ngành sản phẩm — quyết định bộ thuộc tính động (`attributes`).',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'category_id phải là số nguyên' })
  @Min(1, { message: 'category_id không hợp lệ' })
  @Max(INT4_MAX, { message: `category_id ${INT4_MSG}` })
  category_id?: number | null;

  @ApiPropertyOptional({
    example: { material: 'Cotton', warranty_months: 12 },
    description:
      'Giá trị thuộc tính động theo `ProductAttributeDef` của `category_id` — object phẳng `{key: value}`. BE validate kiểu/bắt buộc/option bằng `validateProductAttributes()`.',
    type: 'object',
  })
  @IsOptional()
  @IsObject({ message: 'attributes phải là object' })
  attributes?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'Mô tả sản phẩm', nullable: true })
  @IsOptional()
  @IsString({ message: 'description phải là chuỗi' })
  @MaxLength(PRODUCT_DESCRIPTION_MAX_LENGTH, {
    message: `description tối đa ${PRODUCT_DESCRIPTION_MAX_LENGTH} ký tự`,
  })
  description?: string | null;

  @ApiPropertyOptional({ example: 500000, description: 'Giá bán (VND).', nullable: true })
  @IsOptional()
  @IsInt({ message: 'price phải là số nguyên' })
  @Min(0, { message: 'price không được âm' })
  @Max(PRODUCT_PRICE_CEILING, { message: 'price vượt trần cho phép' })
  price?: number | null;

  @ApiPropertyOptional({ example: 'Acme', nullable: true })
  @IsOptional()
  @IsString({ message: 'brand phải là chuỗi' })
  @MaxLength(255, { message: 'brand tối đa 255 ký tự' })
  brand?: string | null;

  @ApiPropertyOptional({ example: '#00753c', description: 'Màu thương hiệu (hex hoặc tên màu).', nullable: true })
  @IsOptional()
  @IsString({ message: 'color phải là chuỗi' })
  @MaxLength(32, { message: 'color tối đa 32 ký tự' })
  color?: string | null;

  @ApiPropertyOptional({ example: ['Phổ biến', 'Mới'] })
  @ValidateIf(isDefined)
  @IsArray({ message: 'tags phải là mảng' })
  @ArrayMaxSize(PRODUCT_LIST_MAX_ITEMS, { message: `tags tối đa ${PRODUCT_LIST_MAX_ITEMS} phần tử` })
  @IsString({ each: true, message: 'tags chỉ chứa chuỗi' })
  @MaxLength(PRODUCT_LIST_ITEM_MAX_LENGTH, { each: true, message: 'mỗi tag tối đa 255 ký tự' })
  tags?: string[];

  @ApiPropertyOptional({ example: true, description: 'Sản phẩm nổi bật, xếp lên đầu danh sách.' })
  @ValidateIf(isDefined)
  @IsBoolean({ message: 'is_featured phải là boolean' })
  is_featured?: boolean;

  @ApiPropertyOptional({ example: 'https://cdn.example.net/kv-acme.jpg', nullable: true })
  @IsOptional()
  @IsString({ message: 'image_url phải là chuỗi' })
  @MaxLength(2048, { message: 'image_url tối đa 2048 ký tự' })
  image_url?: string | null;
}
