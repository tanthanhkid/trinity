import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches, IsInt, Min } from 'class-validator'
import { Type } from 'class-transformer'

// Thêm 1 nhân viên vào kỳ lương (theo tháng) — tạo phiếu mới hoặc khôi phục phiếu đã loại.
export class AddToPeriodDto {
  @ApiProperty({ description: 'Tháng (YYYY-MM)', example: '2026-06' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month phải có định dạng YYYY-MM',
  })
  month!: string

  @ApiProperty({ description: 'ID nhân viên (employees.id)', example: 12 })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  employee_id!: number
}
