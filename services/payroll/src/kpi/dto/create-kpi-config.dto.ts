import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsString,
  IsNumber,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsIn,
} from 'class-validator'

const VALID_ROLES = [
  'sales',
  'team_lead',
  'marketing',
  'operations',
] as const

export class CreateKpiConfigDto {
  @ApiProperty({
    description: 'Role áp dụng KPI',
    example: 'sales',
    enum: VALID_ROLES,
  })
  @IsString()
  @IsIn([...VALID_ROLES], { message: 'role phải là sales, team_lead, marketing hoặc operations' })
  role!: string

  @ApiProperty({
    description: 'Tên chỉ số KPI',
    example: 'tasks/day',
  })
  @IsString()
  metric_name!: string

  @ApiProperty({
    description: 'Mục tiêu',
    example: 120,
  })
  @IsNumber()
  @Min(0)
  target!: number

  @ApiPropertyOptional({
    description: 'Đơn vị: VND, count, minutes, percent, hours',
    example: 'count',
  })
  @IsOptional()
  @IsString()
  unit?: string

  @ApiPropertyOptional({
    description: 'Trọng số trong tổng KPI (0-100%)',
    example: 25,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  weight?: number

  @ApiPropertyOptional({
    description: 'Số ngày làm việc/tháng',
    example: 24,
    default: 24,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  working_days_per_month?: number
}
