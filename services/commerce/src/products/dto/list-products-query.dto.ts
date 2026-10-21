import { Type, Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { INT4_MAX, INT4_MSG } from '../../common/validation/int4';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query của `GET /products`. `ValidationPipe` toàn cục (`main.ts`) KHÔNG bật
 * `enableImplicitConversion` nên mọi query param tới dưới dạng string
 * PHẢI có `@Type`/`@Transform` tường minh.
 */
export class ListProductsQueryDto {
  @ApiPropertyOptional({ description: 'Chỉ lấy sản phẩm của 1 dự án.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'project_id phải là số nguyên' })
  @Min(1, { message: 'project_id không hợp lệ' })
  @Max(INT4_MAX, { message: `project_id ${INT4_MSG}` })
  project_id?: number;

  @ApiPropertyOptional({ description: 'Chỉ lấy sản phẩm của 1 danh mục/ngành.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'category_id phải là số nguyên' })
  @Min(1, { message: 'category_id không hợp lệ' })
  @Max(INT4_MAX, { message: `category_id ${INT4_MSG}` })
  category_id?: number;

  @ApiPropertyOptional({
    description:
      'Lọc theo trạng thái: `true` = chỉ đang bán, `false` = chỉ đã tắt. ' +
      'KHÔNG gửi = lấy CẢ HAI (màn quản trị cần thấy sản phẩm đã tắt để bật lại).',
  })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean({ message: 'is_active phải là true hoặc false' })
  is_active?: boolean;

  /**
   * `true` ⇒ CHỈ sản phẩm đã xoá (lưu trữ) — để Quản trị xoá hẳn. Mặc định: sản phẩm đang có (chưa xoá).
   */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean({ message: 'archived phải là true hoặc false' })
  archived?: boolean;

  @ApiPropertyOptional({ description: 'Tìm theo tên / mã / thương hiệu (không phân biệt hoa thường).' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'q phải là chuỗi' })
  @MaxLength(255, { message: 'q tối đa 255 ký tự' })
  q?: string;
}
