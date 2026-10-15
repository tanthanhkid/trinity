import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'

export class AuditQueryDto {
  @ApiPropertyOptional({ enum: ['role', 'user'] })
  @IsOptional()
  @IsIn(['role', 'user'])
  targetType?: 'role' | 'user'

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  targetId?: number

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}
