import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

// Loại hợp đồng lao động (HĐLĐ) — 4 giá trị nghiệp vụ hiện hành.
// 4 slug cũ (thu_viec/chinh_thuc/co_thoi_han/khong_thoi_han) GIỮ trong whitelist
// để hồ sơ cũ vẫn sửa/lưu được (không 400), nhưng KHÔNG còn trong dropdown FE.
export const CONTRACT_TYPES = [
  'hdld_vo_thoi_han',
  'hdld_1',
  'hdld_2',
  'hdld_3',
  // Legacy (backward-compat — chỉ để validate giá trị cũ, không hiển thị trong dropdown):
  'thu_viec',
  'chinh_thuc',
  'co_thoi_han',
  'khong_thoi_han',
] as const;

export class CreateContractDto {
  @ApiProperty({ description: 'ID nhân viên', example: 12 })
  @IsInt()
  @Min(1)
  employee_id!: number;

  @ApiPropertyOptional({
    description: 'Loại hợp đồng',
    enum: CONTRACT_TYPES,
    default: 'hdld_1',
  })
  @IsOptional()
  @IsIn(CONTRACT_TYPES)
  contract_type?: string;

  @ApiProperty({ description: 'Ngày ký hợp đồng (ISO)', example: '2026-01-01' })
  @IsDateString()
  signed_date!: string;

  @ApiPropertyOptional({
    description: 'Ngày kết thúc (ISO). Bỏ trống = không thời hạn.',
  })
  @IsOptional()
  @IsDateString()
  end_date?: string | null;

  @ApiPropertyOptional({ description: 'Không còn tác dụng — file chỉ đặt qua endpoint upload' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  file_url?: string | null;

  @ApiPropertyOptional({ description: 'Ghi chú' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({ description: 'Đã chấm dứt hợp đồng', default: false })
  @IsOptional()
  @IsBoolean()
  is_terminated?: boolean;
}
