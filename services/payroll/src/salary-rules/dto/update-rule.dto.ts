import { ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  MaxLength,
  ValidateIf,
} from 'class-validator'
import { Type } from 'class-transformer'
import { SalaryRuleDetailDto } from './create-rule.dto'

export class UpdateSalaryRuleDto {
  @ApiPropertyOptional({ description: 'Vị trí áp dụng' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(50)
  position?: string

  @ApiPropertyOptional({ description: 'Tên bảng lương' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(255)
  name?: string

  @ApiPropertyOptional({ description: 'Mô tả' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string

  @ApiPropertyOptional({
    description: 'Thay thế toàn bộ details (nếu cung cấp)',
    type: [SalaryRuleDetailDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalaryRuleDetailDto)
  details?: SalaryRuleDetailDto[]
}
