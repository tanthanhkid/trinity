import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ValidateNested,
  MaxLength,
  IsInt,
  IsIn,
  Matches,
  Min,
} from 'class-validator'
import { Type } from 'class-transformer'

const COMPONENTS = ['base', 'kpi_bonus', 'allowance'] as const
type Component = (typeof COMPONENTS)[number]

export class SalaryRuleDetailDto {
  @ApiProperty({
    description: 'Loại thành phần lương',
    example: 'base',
    enum: COMPONENTS,
  })
  @IsIn(COMPONENTS)
  component!: Component

  @ApiPropertyOptional({
    description: 'Số tiền cố định (VND, BigInt string)',
    example: '7000000',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,18}$/, { message: 'amount phải là số nguyên không âm (VND)' })
  amount?: string

  @ApiPropertyOptional({
    description: 'Công thức tính (nếu không cố định)',
    example: 'base * achievement_rate / 100',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  formula?: string

  @ApiPropertyOptional({
    description: 'Tham số cho công thức',
    example: { rate: 0.05, min_threshold: 500000000 },
  })
  @IsOptional()
  params?: Record<string, unknown>

  @ApiPropertyOptional({
    description: 'Thứ tự đánh giá',
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number
}

export class CreateSalaryRuleDto {
  @ApiProperty({
    description: 'Vị trí áp dụng',
    example: 'staff',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  position!: string

  @ApiProperty({
    description: 'Tên bảng lương',
    example: 'Bảng lương Q1/2026',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string

  @ApiPropertyOptional({ description: 'Mô tả' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string

  @ApiProperty({ type: [SalaryRuleDetailDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalaryRuleDetailDto)
  details!: SalaryRuleDetailDto[]
}
