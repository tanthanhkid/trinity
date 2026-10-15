import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength,
  ValidateIf,
} from 'class-validator';
import { FIELD_TYPES, KEY_REGEX } from '../field-types';

export class CreateCustomFieldDto {
  @ApiPropertyOptional({ description: 'Bỏ trống = tự sinh từ tên. Không đổi sau khi tạo.' })
  @IsOptional()
  @IsString() @Matches(KEY_REGEX, { message: 'key chỉ gồm a-z, 0-9, _ , bắt đầu bằng chữ, tối đa 48 ký tự' })
  key?: string;

  @ApiProperty({ example: 'Họ và tên học sinh' })
  @IsString({ message: 'Tên trường phải là chuỗi' }) @MinLength(1, { message: 'Tên trường không được rỗng' }) @MaxLength(100, { message: 'Tên trường tối đa 100 ký tự' })
  label!: string;

  @ApiProperty({ enum: FIELD_TYPES })
  @IsIn(FIELD_TYPES as unknown as string[], { message: 'Kiểu trường không hợp lệ' })
  type!: string;

  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() required?: boolean;
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() is_unique?: boolean;
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() is_title?: boolean;
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() show_in_list?: boolean;

  @ApiPropertyOptional({ type: 'object', description: 'select: {choices:[{label,value?,color?}]} · relation: {target_object_id|target:"contact", multiple?} · formula: {expression, format?, decimals?}' })
  @ValidateIf((_o, v) => v !== undefined) @Type(() => Object) @IsObject({ message: 'options phải là object' })
  options?: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsString() @MaxLength(300, { message: 'Ghi chú tối đa 300 ký tự' })
  help_text?: string | null;
}

/** Sửa trường — KHÔNG có `key`. */
export class UpdateCustomFieldDto {
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsString() @MinLength(1) @MaxLength(100, { message: 'Tên trường tối đa 100 ký tự' }) label?: string;
  @ApiPropertyOptional({ enum: FIELD_TYPES }) @ValidateIf((_o, v) => v !== undefined) @IsIn(FIELD_TYPES as unknown as string[], { message: 'Kiểu trường không hợp lệ' }) type?: string;
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() required?: boolean;
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() is_unique?: boolean;
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() is_title?: boolean;
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() show_in_list?: boolean;
  @ApiPropertyOptional({ type: 'object' }) @ValidateIf((_o, v) => v !== undefined) @Type(() => Object) @IsObject() options?: Record<string, unknown>;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(300) help_text?: string | null;
}

export class ReorderCustomFieldsDto {
  @ApiProperty({ description: 'Danh sách key trường theo thứ tự mới — PHẢI đủ mọi trường đang có' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true })
  keys!: string[];
}

export class FormulaPreviewDto {
  @ApiProperty() @IsString() @Matches(KEY_REGEX) object_key!: string;
  @ApiProperty({ example: '{gia_goc}*(1-{uu_dai})' }) @IsString() @MaxLength(300, { message: 'Công thức tối đa 300 ký tự' }) expression!: string;
  @ApiPropertyOptional({ description: 'Giá trị thử: {khoá_trường: giá trị}' }) @IsOptional() @Type(() => Object) @IsObject() sample?: Record<string, unknown>;
  @ApiPropertyOptional({ description: 'Khoá trường đang sửa (để bỏ qua chính nó)' }) @IsOptional() @IsString() editing_key?: string;
}
