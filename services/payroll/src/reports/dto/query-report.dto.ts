import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches } from 'class-validator'

export class QuerySummaryDto {
  @ApiProperty({ example: '2026-03', description: 'Thang bao cao (YYYY-MM)' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month phai co dinh dang YYYY-MM',
  })
  month!: string
}

export class QueryComparisonDto {
  @ApiProperty({
    example: '2026-01,2026-02,2026-03',
    description: 'Danh sach cac thang can so sanh, phan cach bang dau phay',
  })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])(,\s*\d{4}-(0[1-9]|1[0-2])){0,23}$/, {
    message: 'months phai la danh sach YYYY-MM phan cach bang dau phay (toi da 24 thang)',
  })
  months!: string
}

export interface SummaryResponse {
  month: string
  total_employees: number
  total_base_salary: string
  total_kpi_bonus: string
  total_deductions: string
  total_payroll_cost: string
}

export interface DepartmentBreakdown {
  department: string
  employee_count: number
  total_base_salary: string
  total_kpi_bonus: string
  total_deductions: string
  total_cost: string
}

export interface MonthComparison {
  month: string
  total_payroll_cost: string
  employee_count: number
}
