import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsIn,
  IsInt,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  MaxLength,
  Min,
} from 'class-validator'

/** Vị trí hợp lệ — khớp enum Swagger; vị trí lạ (gõ sai) sẽ không có cấu hình KPI nào và im lặng cho ra bảng lương thiếu KPI. */
export const EMPLOYEE_POSITIONS = ['sales', 'team_lead', 'operations', 'marketing', 'accountant', 'chief_accountant', 'hr'] as const

export class CreateEmployeeDto {
  @ApiProperty({ description: 'User ID từ auth service', example: 1 })
  @IsInt()
  @Min(1)
  user_id!: number

  @ApiProperty({
    description: 'Vị trí',
    example: 'sales',
    enum: EMPLOYEE_POSITIONS,
  })
  @IsString()
  @IsNotEmpty()
  @IsIn([...EMPLOYEE_POSITIONS], { message: `position phải là một trong: ${EMPLOYEE_POSITIONS.join(', ')}` })
  @MaxLength(50)
  position!: string

  @ApiPropertyOptional({
    description: 'Phòng ban',
    example: 'Kinh doanh',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string

  @ApiPropertyOptional({ description: 'Team ID', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  team_id?: number

  @ApiProperty({ description: 'Salary rule ID', example: 1 })
  @IsInt()
  @Min(1)
  salary_rule_id!: number

  @ApiProperty({
    description: 'Ngày vào công ty (ISO date)',
    example: '2026-01-15',
  })
  @IsDateString()
  joined_at!: string
}
