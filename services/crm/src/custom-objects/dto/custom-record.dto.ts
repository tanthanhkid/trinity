import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** Chuỗi không chứa NUL (Postgres từ chối → 500). */
const NO_NUL = /^[^\u0000]*$/;
import { LIMITS } from '../field-types';

export class CustomRecordBodyDto {
  @ApiProperty({ type: 'object', description: '{khoá_trường: giá trị}. Trường công thức không nhập được.' })
  // `@Type(() => Object)`: class-transformer 0.5 ném TypeError (→ 500) khi object lồng có khoá riêng `constructor`.
  @Type(() => Object)
  @IsObject({ message: 'data phải là object' })
  data!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Người phụ trách (mặc định = người tạo). Phải nằm trong phạm vi quyền sửa của bạn.' })
  @IsOptional() @IsInt({ message: 'owner_id phải là số nguyên' }) @Min(1)
  owner_id?: number;
}

export class ListCustomRecordsQueryDto {
  @ApiPropertyOptional({ description: 'Tìm theo tiêu đề' })
  @IsOptional() @IsString() @MaxLength(100, { message: 'Từ khoá tối đa 100 ký tự' }) @Matches(NO_NUL, { message: 'Từ khoá chứa ký tự không hợp lệ' })
  q?: string;

  @ApiPropertyOptional({ default: LIMITS.defaultListLimit })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(LIMITS.maxListLimit)
  limit?: number;

  @ApiPropertyOptional({ description: 'Con trỏ trang kế tiếp (từ `next_cursor`)' })
  @IsOptional() @IsString() @MaxLength(400) @Matches(NO_NUL)
  cursor?: string;

  @ApiPropertyOptional({ description: 'Trang (bắt đầu từ 1) — phân trang kiểu số trang; bỏ qua nếu có `cursor`. Luôn trả `total`.', minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000)
  page?: number;

  @ApiPropertyOptional({ description: 'id (mặc định) | updated_at | title | field:<khoá_trường>' })
  @IsOptional() @IsString() @MaxLength(60) @Matches(NO_NUL)
  sort?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional() @IsIn(['asc', 'desc'])
  dir?: 'asc' | 'desc';

  @ApiPropertyOptional({ description: 'JSON: {"<khoá_trường>": giá trị | [giá trị] | {min,max} | {from,to}}' })
  @IsOptional() @IsString() @MaxLength(2000)
  filter?: string;
}

export class LookupQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) @Matches(NO_NUL) q?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @ApiPropertyOptional({ enum: ['view', 'manage'], description: 'users: lấy trong phạm vi quyền xem (mặc định) hay quyền sửa (chọn người phụ trách)' })
  @IsOptional() @IsIn(['view', 'manage']) for?: 'view' | 'manage';
}
