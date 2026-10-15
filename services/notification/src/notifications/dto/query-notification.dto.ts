import {
  IsOptional,
  IsInt,
  IsBoolean,
  Min,
  Max,
} from 'class-validator'
import { Type, Transform } from 'class-transformer'
import { ApiPropertyOptional } from '@nestjs/swagger'

export class QueryNotificationDto {
  @ApiPropertyOptional({ description: 'Cursor de phan trang (ID cuoi)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cursor?: number

  @ApiPropertyOptional({ default: 20, description: 'So luong ban ghi' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number

  @ApiPropertyOptional({ description: 'Loc theo trang thai da doc' })
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  read?: boolean
}
