import { IsInt, IsOptional, IsString, Min, Max, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export const EMPLOYEE_SORT_FIELDS = [
  'full_name', 'employee_code', 'position', 'department', 'status', 'joined_at',
] as const;

export class QueryEmployeesDto {
  @ApiPropertyOptional({ description: 'Số trang (bắt đầu từ 1)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Số bản ghi mỗi trang', default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number = 25;

  @ApiPropertyOptional({ description: 'Tìm kiếm theo tên, email, SĐT, mã NV' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Lọc theo phòng ban', example: 'KD' })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({ description: 'Lọc theo chức vụ', example: 'sales' })
  @IsOptional()
  @IsString()
  position?: string;

  @ApiPropertyOptional({
    description: 'Lọc theo trạng thái làm việc',
    enum: ['unclassified', 'active', 'on_leave', 'probation', 'waiting', 'resigned'],
  })
  @IsOptional()
  @IsString()
  status?: string;

  // giá trị = id CHÍNH THỨC bảng `teams` (KHÔNG phải team_lead user id) —
  // khớp `resolveTeam().team_id` (mapEmployee) hỗ trợ cả team chưa có Người phụ
  // trách (gán trực tiếp employees.team_id, vd "Team Alpha"). 'none' = chưa có team.
  @ApiPropertyOptional({ description: "Lọc theo team (id bảng teams, hoặc 'none')" })
  @IsOptional()
  @IsString()
  team?: string;

  @ApiPropertyOptional({
    description:
      'Lọc theo tình trạng tài khoản: active=đang làm việc, resigned=đã nghỉ (vô hiệu hoá), all=tất cả. Mặc định (vắng) = tất cả.',
    enum: ['active', 'resigned', 'all'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['active', 'resigned', 'all'])
  employment_state?: string;

  @ApiPropertyOptional({ description: 'Cột sắp xếp', enum: EMPLOYEE_SORT_FIELDS })
  @IsOptional()
  @IsIn(EMPLOYEE_SORT_FIELDS)
  sort_by?: string;

  @ApiPropertyOptional({ description: 'Chiều sắp xếp', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort_dir?: string;
}
