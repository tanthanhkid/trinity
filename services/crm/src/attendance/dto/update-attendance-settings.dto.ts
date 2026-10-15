import { IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Cấu hình ca làm việc — giờ vào/ra + mốc tính đi muộn (định dạng HH:MM, giờ VN). */
export class UpdateAttendanceSettingsDto {
  @ApiProperty({ example: '08:00', description: 'Giờ bắt đầu ca (HH:MM)' })
  @IsString()
  @Matches(HM, { message: 'Giờ bắt đầu ca phải có định dạng HH:MM (00:00–23:59)' })
  work_start!: string;

  @ApiProperty({ example: '17:00', description: 'Giờ kết thúc ca (HH:MM)' })
  @IsString()
  @Matches(HM, { message: 'Giờ kết thúc ca phải có định dạng HH:MM (00:00–23:59)' })
  work_end!: string;

  @ApiProperty({ example: '08:10', description: 'Check-in sau mốc này tính đi muộn (HH:MM)' })
  @IsString()
  @Matches(HM, { message: 'Mốc đi muộn phải có định dạng HH:MM (00:00–23:59)' })
  late_after!: string;

  @ApiPropertyOptional({ example: '12:00', description: 'Giờ bắt đầu nghỉ trưa (HH:MM) — tự trừ khỏi giờ làm' })
  @IsOptional()
  @IsString()
  @Matches(HM, { message: 'Giờ bắt đầu nghỉ trưa phải có định dạng HH:MM (00:00–23:59)' })
  lunch_start?: string;

  @ApiPropertyOptional({ example: '13:00', description: 'Giờ kết thúc nghỉ trưa (HH:MM)' })
  @IsOptional()
  @IsString()
  @Matches(HM, { message: 'Giờ kết thúc nghỉ trưa phải có định dạng HH:MM (00:00–23:59)' })
  lunch_end?: string;

  @ApiPropertyOptional({ example: 1, description: 'Tổng giờ dưới mức này → trạng thái "Xem xét" (giờ)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Ngưỡng "Xem xét" phải là số (giờ)' })
  @Min(0, { message: 'Ngưỡng "Xem xét" tối thiểu 0 giờ' })
  @Max(24, { message: 'Ngưỡng "Xem xét" tối đa 24 giờ' })
  review_max_hours?: number;

  @ApiPropertyOptional({ example: 4, description: 'Tổng giờ dưới mức này (và >= Xem xét) → "Chưa đủ nửa ngày" (giờ)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Ngưỡng "Chưa đủ nửa ngày" phải là số (giờ)' })
  @Min(0, { message: 'Ngưỡng "Chưa đủ nửa ngày" tối thiểu 0 giờ' })
  @Max(24, { message: 'Ngưỡng "Chưa đủ nửa ngày" tối đa 24 giờ' })
  half_day_min_hours?: number;

  @ApiPropertyOptional({ example: 8, description: 'Tổng giờ từ mức này trở lên → đủ công (giờ)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Số giờ đủ công phải là số (giờ)' })
  @Min(0, { message: 'Số giờ đủ công tối thiểu 0 giờ' })
  @Max(24, { message: 'Số giờ đủ công tối đa 24 giờ' })
  full_day_min_hours?: number;
}
