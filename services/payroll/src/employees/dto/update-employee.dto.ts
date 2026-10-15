import { ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsString,
  IsIn,
  IsOptional,
  IsInt,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator'
import { EMPLOYEE_POSITIONS } from './create-employee.dto'

export const EMPLOYEE_STATUSES = [
  'active',
  'on_leave',
  'probation',
  'resigned',
] as const

export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]

export class UpdateEmployeeDto {
  @ApiPropertyOptional({ description: 'Vị trí', example: 'team_lead' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(50)
  @IsIn([...EMPLOYEE_POSITIONS], { message: `position phải là một trong: ${EMPLOYEE_POSITIONS.join(', ')}` })
  position?: string

  @ApiPropertyOptional({ description: 'Phòng ban', example: 'KD' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string

  @ApiPropertyOptional({ description: 'Team ID', example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  team_id?: number

  @ApiPropertyOptional({ description: 'Salary rule ID', example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  salary_rule_id?: number

  @ApiPropertyOptional({
    description: 'Trạng thái',
    enum: EMPLOYEE_STATUSES,
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(EMPLOYEE_STATUSES)
  status?: EmployeeStatus
}
