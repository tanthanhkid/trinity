import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryAttendanceRequestsDto {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected'], description: 'Lọc theo trạng thái đơn' })
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'], { message: 'status phải là pending, approved hoặc rejected' })
  status?: string;

  @ApiPropertyOptional({ example: 1, description: 'Trang (bắt đầu từ 1)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page phải là số nguyên' })
  page?: number;

  @ApiPropertyOptional({ example: 20, description: 'Số bản ghi mỗi trang' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page_size phải là số nguyên' })
  page_size?: number;

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
