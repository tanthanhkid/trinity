import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

export class InspectSheetDto {
  @ApiProperty({ description: 'URL Google Sheet hoặc ID' })
  @IsString() @MinLength(10) @MaxLength(500)
  spreadsheet!: string;

  @ApiPropertyOptional({ description: 'Tên tab để đọc dòng tiêu đề (bỏ trống = chỉ liệt kê tab)' })
  @IsOptional() @IsString() @MaxLength(200)
  tab?: string;
}

export class CreateSyncDto {
  @IsString() @MinLength(1) @MaxLength(100)
  name!: string;

  @ApiProperty({ enum: ['import', 'export'] })
  @IsIn(['import', 'export'])
  direction!: 'import' | 'export';

  @ApiProperty({ description: 'URL Google Sheet hoặc ID (xuất có thể bỏ trống + create_sheet=true để tạo Sheet mới)' })
  @IsOptional() @IsString() @MaxLength(500)
  spreadsheet?: string;

  @ApiPropertyOptional({ description: 'Xuất: tạo Sheet mới thay vì dùng Sheet có sẵn' })
  @IsOptional() @IsBoolean()
  create_sheet?: boolean;

  @IsString() @MinLength(1) @MaxLength(200)
  sheet_title!: string;

  @ApiProperty({ enum: ['contact', 'custom_object'] })
  @IsIn(['contact', 'custom_object'])
  target_kind!: 'contact' | 'custom_object';

  @IsOptional() @IsString() @MaxLength(48)
  target_object_key?: string;

  @ApiProperty({ description: '{ khoá trường CRM: tên cột trong Sheet }' })
  @IsObject()
  column_map!: Record<string, string>;

  @ApiPropertyOptional({ description: 'Nhập: khoá khử trùng (phone | email | khoá trường tuỳ biến). Mặc định phone.' })
  @IsOptional() @IsString() @MaxLength(48)
  dedupe_key?: string;

  @ApiPropertyOptional({ description: 'Nhập: người nhận khách (mặc định = người tạo cấu hình)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  actor_user_id?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  contact_source_id?: number;

  @ApiPropertyOptional({ description: 'Chu kỳ tự chạy (phút, 5–1440); bỏ trống = chạy tay' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(1440)
  schedule_minutes?: number | null;
}

export class UpdateSyncDto {
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MinLength(1) @MaxLength(100)
  name?: string;

  @ValidateIf((_o, v) => v !== undefined) @IsBoolean()
  is_active?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(1440)
  schedule_minutes?: number | null;

  @ValidateIf((_o, v) => v !== undefined) @IsObject()
  column_map?: Record<string, string>;

  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(48)
  dedupe_key?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  contact_source_id?: number | null;
}

export class RunSyncDto {
  @ApiPropertyOptional({ description: 'Xuất: đẩy cả dữ liệu hiện có (tối đa 5000 dòng), không chỉ dữ liệu mới' })
  @IsOptional() @IsBoolean()
  backfill?: boolean;
}
