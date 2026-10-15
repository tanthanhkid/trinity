import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Tạo mới một option cấu hình động.
 * `group_key` + `value` phải duy nhất (unique index).
 */
export class CreateOptionDto {
  @ApiProperty({
    example: 'contact_source',
    description:
      'Nhóm option, vd: contact_source, contact_stage, contact_detail_status',
  })
  @IsNotEmpty({ message: 'Nhóm option (group_key) không được để trống' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,49}$/, {
    message: 'group_key chỉ chứa a-z, 0-9, _ và bắt đầu bằng chữ thường',
  })
  group_key!: string;

  @ApiProperty({
    example: 'in_progress',
    description: 'Giá trị nội bộ (a-z, 0-9, _), duy nhất trong group',
  })
  @IsNotEmpty({ message: 'Giá trị option (value) không được để trống' })
  @IsString()
  @Matches(/^[a-z0-9_]{1,64}$/, {
    message: 'value chỉ được chứa a-z, 0-9, _ (tối đa 64 ký tự)',
  })
  value!: string;

  @ApiProperty({
    example: 'Khách giới thiệu',
    description: 'Nhãn hiển thị tiếng Việt có dấu',
  })
  @IsNotEmpty({ message: 'Nhãn hiển thị không được để trống' })
  @IsString()
  @MaxLength(100, { message: 'Nhãn tối đa 100 ký tự' })
  label!: string;

  @ApiPropertyOptional({ example: 1, description: 'Thứ tự sắp xếp (asc)' })
  @IsOptional()
  @IsInt({ message: 'sort_order phải là số nguyên' })
  @Min(0, { message: 'sort_order phải >= 0' })
  sort_order?: number;

  @ApiPropertyOptional({ example: true, description: 'Đang bật hiển thị' })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({
    description: 'Metadata bổ sung (tuỳ chọn)',
  })
  @IsOptional()
  @IsObject({ message: 'metadata phải là object JSON' })
  metadata?: Record<string, unknown>;
}
