import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  IsArray,
  ValidateNested,
  ValidateIf,
  ArrayMaxSize,
  MaxLength,
  MinLength,
  Matches,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { INT4_MAX, INT4_MSG } from '../../../common/validation/int4';
import { isDefined } from '../../dto/create-product.dto';
import { PRODUCT_ATTRIBUTE_TYPES } from '../../product-attributes.validator';
import { AttributeOptionDto } from './attribute-option.dto';

/** Định nghĩa 1 thuộc tính động của 1 danh mục. */
export class CreateAttributeDefDto {
  @ApiProperty({
    example: 'material',
    description: 'Khoá kỹ thuật — key trong `Product.attributes` JSON. KHÔNG đổi được sau khi tạo.',
  })
  @IsString({ message: 'key phải là chuỗi' })
  @MinLength(1, { message: 'key không được rỗng' })
  @MaxLength(64, { message: 'key tối đa 64 ký tự' })
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'key chỉ chứa chữ thường/số/gạch dưới, bắt đầu bằng chữ',
  })
  key!: string;

  @ApiProperty({ example: 'Chất liệu' })
  @IsString({ message: 'label phải là chuỗi' })
  @MinLength(1, { message: 'label không được rỗng' })
  @MaxLength(255, { message: 'label tối đa 255 ký tự' })
  label!: string;

  @ApiProperty({ example: 'text', enum: PRODUCT_ATTRIBUTE_TYPES })
  @IsIn(PRODUCT_ATTRIBUTE_TYPES, {
    message: `type phải là 1 trong: ${PRODUCT_ATTRIBUTE_TYPES.join(', ')}`,
  })
  type!: (typeof PRODUCT_ATTRIBUTE_TYPES)[number];

  @ApiPropertyOptional({
    type: [AttributeOptionDto],
    description: 'Danh sách lựa chọn — BẮT BUỘC khi type=select|multiselect.',
  })
  @IsOptional()
  @IsArray({ message: 'options phải là mảng' })
  @ArrayMaxSize(100, { message: 'options tối đa 100 phần tử' })
  @ValidateNested({ each: true })
  @Type(() => AttributeOptionDto)
  options?: AttributeOptionDto[];

  @ApiPropertyOptional({ example: false })
  @ValidateIf(isDefined)
  @IsBoolean({ message: 'is_required phải là boolean' })
  is_required?: boolean;

  @ApiPropertyOptional({ example: 0 })
  @ValidateIf(isDefined)
  @IsInt({ message: 'sort_order phải là số nguyên' })
  @Min(0, { message: 'sort_order không được âm' })
  @Max(INT4_MAX, { message: `sort_order ${INT4_MSG}` })
  sort_order?: number;
}
