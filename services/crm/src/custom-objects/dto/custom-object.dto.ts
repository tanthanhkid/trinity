import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength,
  ValidateIf,
} from 'class-validator';
import { KEY_REGEX } from '../field-types';

/** Tạo thực thể tuỳ biến. `key` là slug bất biến (URL `/x/<key>`). */
export class CreateCustomObjectDto {
  @ApiProperty({ example: 'hoc_sinh', description: 'a-z, 0-9, _ ; bắt đầu bằng chữ; tối đa 48 ký tự; không đổi sau khi tạo' })
  @IsString({ message: 'key phải là chuỗi' })
  @Matches(KEY_REGEX, { message: 'key chỉ gồm a-z, 0-9, _ , bắt đầu bằng chữ, tối đa 48 ký tự' })
  key!: string;

  @ApiProperty({ example: 'Học sinh' })
  @IsString({ message: 'Tên phải là chuỗi' })
  @MinLength(1, { message: 'Tên không được rỗng' })
  @MaxLength(100, { message: 'Tên tối đa 100 ký tự' })
  label!: string;

  @ApiProperty({ example: 'Học sinh' })
  @IsString({ message: 'Tên số nhiều phải là chuỗi' })
  @MinLength(1, { message: 'Tên số nhiều không được rỗng' })
  @MaxLength(100, { message: 'Tên số nhiều tối đa 100 ký tự' })
  label_plural!: string;

  @ApiPropertyOptional({ example: 'graduation-cap', nullable: true })
  @IsOptional() @IsString({ message: 'icon phải là chuỗi' }) @MaxLength(48, { message: 'icon tối đa 48 ký tự' })
  icon?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsString({ message: 'Mô tả phải là chuỗi' }) @MaxLength(500, { message: 'Mô tả tối đa 500 ký tự' })
  description?: string | null;

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean({ message: 'show_in_nav phải là boolean' })
  show_in_nav?: boolean;

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined) @IsInt({ message: 'nav_order phải là số nguyên' }) @Min(0) @Max(100000)
  nav_order?: number;

  @ApiPropertyOptional({ description: 'Vai trò nào THẤY thực thể; rỗng = mọi người có quyền xem. Chỉ thu hẹp, không cấp thêm quyền.' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray({ message: 'visible_role_ids phải là mảng' })
  @ArrayMaxSize(50, { message: 'visible_role_ids tối đa 50 vai trò' })
  @IsInt({ each: true, message: 'visible_role_ids chỉ chứa số nguyên' })
  @Min(1, { each: true })
  visible_role_ids?: number[];

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean({ message: 'is_active phải là boolean' })
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'Tiền tố mã bản ghi, 2–4 chữ in hoa không dấu (HS → HS001). Bỏ trống = tự sinh từ tên.' })
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2,4}$/, { message: 'Tiền tố mã gồm 2–4 chữ cái không dấu' })
  code_prefix?: string;
}

/** Sửa thực thể — KHÔNG có `key` (bất biến). Chỉ trường nào gửi lên mới đổi. */
export class UpdateCustomObjectDto {
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MinLength(1) @MaxLength(100, { message: 'Tên tối đa 100 ký tự' })
  label?: string;

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MinLength(1) @MaxLength(100, { message: 'Tên số nhiều tối đa 100 ký tự' })
  label_plural?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsString() @MaxLength(48)
  icon?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsString() @MaxLength(500, { message: 'Mô tả tối đa 500 ký tự' })
  description?: string | null;

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean()
  show_in_nav?: boolean;

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(0) @Max(100000)
  nav_order?: number;

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMaxSize(50) @IsInt({ each: true }) @Min(1, { each: true })
  visible_role_ids?: number[];

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'Tiền tố mã bản ghi, 2–4 chữ in hoa không dấu (HS → HS001). Bỏ trống = tự sinh từ tên.' })
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2,4}$/, { message: 'Tiền tố mã gồm 2–4 chữ cái không dấu' })
  code_prefix?: string;
}

export class ApplyTemplateDto {
  @ApiPropertyOptional({ description: 'Tạo kèm dữ liệu mẫu GIẢ (tên giả, SĐT 0900000xxx)', default: false })
  @IsOptional() @IsBoolean({ message: 'with_sample_data phải là boolean' })
  with_sample_data?: boolean;
}
