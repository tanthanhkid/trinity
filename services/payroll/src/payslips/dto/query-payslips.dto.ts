import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsString,
  Matches,
  IsOptional,
  IsInt,
  IsIn,
  Min,
} from 'class-validator'
import { Type } from 'class-transformer'

export class QueryPayslipsDto {
  @ApiProperty({ description: 'Tháng (YYYY-MM)', example: '2026-03' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month phải có định dạng YYYY-MM',
  })
  month!: string

  @ApiPropertyOptional({ description: 'Lọc theo team', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  team_id?: number

  @ApiPropertyOptional({
    description: 'Trạng thái phiếu lương',
    enum: ['draft', 'pending_tl', 'pending_accountant', 'approved', 'paid'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['draft', 'pending_tl', 'pending_accountant', 'approved', 'paid'])
  status?: string
}
