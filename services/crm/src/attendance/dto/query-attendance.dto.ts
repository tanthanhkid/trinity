import { IsOptional, IsDateString, IsInt, Min, Max, IsString, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryAttendanceDto {
  @ApiPropertyOptional({ description: 'Từ ngày (ISO date, VD: 2026-06-01)' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiPropertyOptional({ description: 'Đến ngày (ISO date, VD: 2026-06-30)' })
  @IsOptional()
  @IsDateString()
  date_to?: string;

  @ApiPropertyOptional({ description: 'Lọc theo user_id (chỉ super_admin)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  user_id?: number;

  @ApiPropertyOptional({ description: 'Trang hiện tại', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Số dòng mỗi trang', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number = 20;

  @ApiPropertyOptional({
    description:
      'Cột sắp xếp (mặc định check_in — ai chấm vào sớm nhất lên đầu). ' +
      '"org" = sắp theo sơ đồ tổ chức (Phòng ban → Team → cấp chức danh → tên).',
    enum: ['work_date', 'employee', 'check_in', 'check_out', 'total_hours', 'status', 'org'],
    default: 'check_in',
  })
  @IsOptional()
  @IsString()
  @IsIn(['work_date', 'employee', 'check_in', 'check_out', 'total_hours', 'status', 'org'])
  sort_by?: string;

  @ApiPropertyOptional({
    description: 'Chiều sắp xếp (mặc định asc)',
    enum: ['asc', 'desc'],
    default: 'asc',
  })
  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  sort_dir?: string;

  @ApiPropertyOptional({ description: 'Tìm theo tên nhân viên (không phân biệt hoa thường)' })
  @IsOptional()
  @IsString()
  search?: string;

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

  @ApiPropertyOptional({
    description: 'Lọc theo trạng thái (tính lại từ giờ chấm)',
    enum: [
      'present',
      'late',
      'half_day',
      'insufficient',
      'review',
      'incomplete',
      'leave',
      'maternity',
    ],
  })
  @IsOptional()
  @IsString()
  @IsIn([
    'present',
    'late',
    'half_day',
    'insufficient',
    'review',
    'incomplete',
    'leave',
    'maternity',
  ])
  status?: string;
}

export class QueryTodaySummaryDto {
  @ApiPropertyOptional({ description: 'work_date ISO date (mặc định hôm nay VN)' })
  @IsOptional()
  @IsDateString()
  date?: string;
}
