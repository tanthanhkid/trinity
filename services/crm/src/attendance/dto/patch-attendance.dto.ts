import {
  IsOptional,
  IsString,
  IsNumber,
  IsIn,
  IsDateString,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PatchAttendanceDto {
  @ApiPropertyOptional({ description: 'Thời gian check-in (ISO)' })
  @IsOptional()
  @IsString()
  check_in_at?: string;

  @ApiPropertyOptional({ description: 'Thời gian check-out (ISO)' })
  @IsOptional()
  @IsString()
  check_out_at?: string;

  @ApiPropertyOptional({ description: 'Ghi chú check-in' })
  @IsOptional()
  @IsString()
  check_in_note?: string;

  @ApiPropertyOptional({ description: 'Ghi chú check-out' })
  @IsOptional()
  @IsString()
  check_out_note?: string;

  @ApiPropertyOptional({ description: 'Tổng giờ làm việc' })
  @IsOptional()
  @IsNumber()
  total_hours?: number;

  @ApiPropertyOptional({ description: 'Số phút đi muộn' })
  @IsOptional()
  @IsNumber()
  late_minutes?: number;

  @ApiPropertyOptional({ description: 'Trạng thái', enum: ['incomplete', 'present', 'late', 'half_day'] })
  @IsOptional()
  @IsIn(['incomplete', 'present', 'late', 'half_day'])
  status?: string;
}
