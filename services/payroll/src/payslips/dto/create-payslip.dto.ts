import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsString, Matches, Min } from 'class-validator'

export class CreatePayslipDto {
  @ApiProperty({ description: 'Employee ID', example: 1 })
  @IsInt()
  @Min(1)
  employee_id!: number

  @ApiProperty({ description: 'Tháng (YYYY-MM)', example: '2026-03' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month phải có định dạng YYYY-MM',
  })
  month!: string
}
