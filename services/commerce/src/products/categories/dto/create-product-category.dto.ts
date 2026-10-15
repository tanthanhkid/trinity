import { IsString, IsOptional, IsBoolean, IsInt, MaxLength, MinLength, Matches, Min, Max, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { INT4_MAX, INT4_MSG } from '../../../common/validation/int4';
import { isDefined } from '../../dto/create-product.dto';

/**
 * Danh mục/ngành sản phẩm — mirror `CreateProductDto` về style
 * (mã bất biến, tên/mô tả tự do). `is_active`/`sort_order` dùng
 * `@ValidateIf(isDefined)` thay vì `@IsOptional()` vì 2 cột NOT NULL — DTO này
 * còn được `UpdateProductCategoryDto` tái sử dụng qua `PartialType`, và
 * `@IsOptional()` của class-validator bỏ qua CẢ `null` khiến `null` lọt tới
 * Prisma trên cột NOT NULL = 500 (mirror bug đã sửa ở, xem
 * docblock `isDefined`).
 */
export class CreateProductCategoryDto {
  @ApiProperty({ example: 'retail', description: 'Mã danh mục — UNIQUE, KHÔNG đổi được sau khi tạo.' })
  @IsString({ message: 'code phải là chuỗi' })
  @MinLength(2, { message: 'Mã danh mục tối thiểu 2 ký tự' })
  @MaxLength(64, { message: 'Mã danh mục tối đa 64 ký tự' })
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'Mã danh mục chỉ chứa chữ, số, gạch ngang và gạch dưới',
  })
  code!: string;

  @ApiProperty({ example: 'Bán lẻ' })
  @IsString({ message: 'name phải là chuỗi' })
  @MinLength(2, { message: 'Tên danh mục tối thiểu 2 ký tự' })
  @MaxLength(255, { message: 'Tên danh mục tối đa 255 ký tự' })
  name!: string;

  @ApiPropertyOptional({ example: 'Sản phẩm dịch vụ', nullable: true })
  @IsOptional()
  @IsString({ message: 'description phải là chuỗi' })
  @MaxLength(2000, { message: 'description tối đa 2000 ký tự' })
  description?: string | null;

  @ApiPropertyOptional({ example: 0, description: 'Thứ tự hiển thị — nhỏ trước.' })
  @ValidateIf(isDefined)
  @IsInt({ message: 'sort_order phải là số nguyên' })
  @Min(0, { message: 'sort_order không được âm' })
  @Max(INT4_MAX, { message: `sort_order ${INT4_MSG}` })
  sort_order?: number;

  @ApiPropertyOptional({ example: true })
  @ValidateIf(isDefined)
  @IsBoolean({ message: 'is_active phải là boolean' })
  is_active?: boolean;
}
