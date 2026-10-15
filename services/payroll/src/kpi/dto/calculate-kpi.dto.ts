import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsString,
  Matches,
  IsOptional,
  IsArray,
  IsInt,
  Min,
} from 'class-validator'
import { Type } from 'class-transformer'

export class CalculateKpiDto {
  @ApiProperty({
    description: 'Thang tinh KPI (YYYY-MM)',
    example: '2026-03',
  })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month phai dung format YYYY-MM',
  })
  month!: string

  @ApiPropertyOptional({
    description:
      'Danh sach employee IDs (bo trong de tinh tat ca)',
    example: [1, 2, 3],
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Type(() => Number)
  employee_ids?: number[]
}
