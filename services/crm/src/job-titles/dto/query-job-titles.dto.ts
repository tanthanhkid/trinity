import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator'
import { Transform } from 'class-transformer'

export class QueryJobTitlesDto {
  @ApiPropertyOptional({ example: 'Nhân viên', description: 'Lọc theo nhóm chức danh' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  category?: string

  @ApiPropertyOptional({ example: true, description: 'Lọc theo trạng thái hiệu lực' })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  })
  @IsBoolean()
  is_active?: boolean
}
