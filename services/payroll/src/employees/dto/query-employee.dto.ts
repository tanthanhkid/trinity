import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, IsInt, Min, MaxLength } from 'class-validator'
import { Type } from 'class-transformer'

export class QueryEmployeeDto {
  @ApiPropertyOptional({ description: 'Filter theo team_id', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  team_id?: number

  @ApiPropertyOptional({ description: 'Filter theo position', example: 'sales' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  position?: string

  @ApiPropertyOptional({ description: 'Filter theo status', example: 'active' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string

  @ApiPropertyOptional({ description: 'Tìm theo tên', example: 'Nguyen' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string
}
