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

export class GeneratePayslipsDto {
  @ApiProperty({ description: 'Tháng (YYYY-MM)', example: '2026-03' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month phải có định dạng YYYY-MM',
  })
  month!: string

  @ApiPropertyOptional({
    description: 'Danh sách employee IDs (bỏ trống = tất cả active)',
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
