import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString } from 'class-validator'

export class QueryKpiConfigDto {
  @ApiPropertyOptional({
    description: 'Filter theo role',
    example: 'sales',
  })
  @IsOptional()
  @IsString()
  role?: string
}
