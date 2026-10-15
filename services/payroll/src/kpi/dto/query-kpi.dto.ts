import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator'
import { Type } from 'class-transformer'

export class QueryKpiDto {
  @ApiProperty({
    description: 'ID nhan vien',
    example: 10,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employee_id!: number

  @ApiProperty({
    description: 'Thang (YYYY-MM)',
    example: '2026-03',
  })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month phai dung format YYYY-MM',
  })
  month!: string

  @ApiPropertyOptional({
    description: 'Filter theo team (cho team_lead)',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  team_id?: number
}
