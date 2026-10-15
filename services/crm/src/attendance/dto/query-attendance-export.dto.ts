import { IsOptional, IsDateString, IsInt, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Tham số xuất Excel chấm công. KHÔNG phân trang — xuất toàn bộ bản ghi trong
 * khoảng ngày (cap ở service). Khoảng ngày do FE tính sẵn theo preset
 * (hôm nay / hôm qua / 2 ngày trước / tuần này / tháng này / tháng trước).
 *
 * `team_id`/`department`/`job_title_id`: forward CHÍNH XÁC bộ lọc
 * Phòng ban/Team/Chức danh đang xem trên UI xuống Excel để dữ liệu
 * Excel khớp bảng đang xem ("Chi tiết theo ngày" + "Tổng hợp theo nhân viên").
 */
export class QueryAttendanceExportDto {
  @ApiPropertyOptional({ description: 'Từ ngày (ISO date, VD: 2026-06-01)' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiPropertyOptional({ description: 'Đến ngày (ISO date, VD: 2026-06-30)' })
  @IsOptional()
  @IsDateString()
  date_to?: string;

  @ApiPropertyOptional({ description: 'Lọc theo 1 nhân viên (user_id)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  user_id?: number;

  @ApiPropertyOptional({ description: 'Lọc theo team_id (employees.team_id)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  team_id?: number;

  @ApiPropertyOptional({ description: 'Lọc theo phòng ban (employees.department)' })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({ description: 'Lọc theo chức danh (employees.job_title_id)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  job_title_id?: number;
}
