import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { CONTRACT_TYPES } from './create-contract.dto';

// Cập nhật hợp đồng — KHÔNG cho đổi employee_id (hợp đồng thuộc 1 nhân viên cố định).
export class UpdateContractDto {
  @ApiPropertyOptional({ enum: CONTRACT_TYPES })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(CONTRACT_TYPES)
  contract_type?: string;

  @ApiPropertyOptional({ description: 'Ngày ký hợp đồng (ISO)' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsDateString()
  signed_date?: string;

  @ApiPropertyOptional({ description: 'Ngày kết thúc (ISO). null = không thời hạn.' })
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

  @ApiPropertyOptional({ description: 'Đã chấm dứt hợp đồng' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_terminated?: boolean;
}
