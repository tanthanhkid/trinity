import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CONTRACT_TYPES } from './create-contract.dto';

export const CONTRACT_SORT_FIELDS = [
  'full_name',
  'employee_code',
  'signed_date',
  'end_date',
  'days_remaining',
  'status',
  'contract_type',
] as const;

// Trạng thái hợp đồng (tính từ end_date + is_terminated) dùng để lọc danh sách.
export const CONTRACT_STATUSES = [
  'active', // còn hiệu lực
  'expiring', // sắp hết hạn (≤30 ngày)
  'expired', // đã hết hạn
  'terminated', // đã chấm dứt
  'no_contract', // chưa có hợp đồng (nhân viên chưa được lập HĐ)
] as const;

// Tình trạng làm việc của nhân viên (suy từ employees.status).
export const EMPLOYMENT_STATUSES = ['working', 'resigned'] as const;

export class QueryContractsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  page_size?: number;

  @ApiPropertyOptional({ description: 'Tìm theo mã / tên / email nhân viên' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Lọc theo bộ phận' })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({ description: 'Lọc theo chức vụ' })
  @IsOptional()
  @IsString()
  position?: string;

  @ApiPropertyOptional({ description: 'Lọc theo trạng thái hợp đồng', enum: CONTRACT_STATUSES })
  @IsOptional()
  @IsIn(CONTRACT_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Lọc theo loại hợp đồng', enum: CONTRACT_TYPES })
  @IsOptional()
  @IsIn(CONTRACT_TYPES)
  contract_type?: string;

  @ApiPropertyOptional({ description: 'Lọc theo tình trạng làm việc', enum: EMPLOYMENT_STATUSES })
  @IsOptional()
  @IsIn(EMPLOYMENT_STATUSES)
  employment_status?: string;

  // giá trị = id CHÍNH THỨC bảng `teams` (KHÔNG phải team_lead user id) —
  // hỗ trợ cả team chưa có Người phụ trách (gán trực tiếp employees.team_id).
  @ApiPropertyOptional({ description: 'Lọc theo team (id bảng teams)' })
  @IsOptional()
  @IsString()
  team?: string;

  @ApiPropertyOptional({
    description: 'Sắp xếp theo trường',
    enum: CONTRACT_SORT_FIELDS,
  })
  @IsOptional()
  @IsString()
  @IsIn(CONTRACT_SORT_FIELDS)
  sort_by?: string;

  @ApiPropertyOptional({ description: 'Hướng sắp xếp', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  sort_dir?: string;
}
