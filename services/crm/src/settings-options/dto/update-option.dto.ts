import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Cập nhật option cấu hình động.
 * KHÔNG cho đổi `group_key` + `value` (tránh orphan FK từ bảng khác).
 */
export class UpdateOptionDto {
  @ApiPropertyOptional({
    example: 'Nhãn mới',
    description: 'Nhãn hiển thị mới',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(100, { message: 'Nhãn tối đa 100 ký tự' })
  label?: string;

  @ApiPropertyOptional({ example: 5, description: 'Thứ tự sắp xếp mới' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt({ message: 'sort_order phải là số nguyên' })
  @Min(0, { message: 'sort_order phải >= 0' })
  sort_order?: number;

  @ApiPropertyOptional({ example: false, description: 'Bật/tắt hiển thị' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({
    description: 'Metadata bổ sung (gộp hoặc thay thế tuỳ service)',
  })
  @IsOptional()
  @IsObject({ message: 'metadata phải là object JSON' })
  metadata?: Record<string, unknown>;
}
