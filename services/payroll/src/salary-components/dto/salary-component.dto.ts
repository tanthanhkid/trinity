import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger'
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsInt,
  IsNumber,
  IsBoolean,
  Min,
  Max,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator'

export const COMPONENT_TYPES = ['allowance', 'bonus', 'deduction'] as const
export const CALC_METHODS = ['fixed', 'percent_base'] as const
const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/

export class CreateSalaryComponentDto {
  @ApiProperty({ description: 'Tên thành phần', example: 'Phụ cấp điện thoại' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string

  @ApiProperty({ description: 'Mã (slug duy nhất)', example: 'allowance_phone' })
  @IsString()
  @Matches(/^[a-z0-9_]+$/, {
    message: 'Mã chỉ gồm chữ thường, số và dấu gạch dưới',
  })
  @MaxLength(60)
  code!: string

  @ApiProperty({ enum: COMPONENT_TYPES, description: 'Loại thành phần' })
  @IsIn(COMPONENT_TYPES)
  component_type!: (typeof COMPONENT_TYPES)[number]

  @ApiPropertyOptional({ enum: CALC_METHODS, description: 'Cách tính' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(CALC_METHODS)
  calc_method?: (typeof CALC_METHODS)[number]

  @ApiPropertyOptional({ description: 'Số tiền cố định (VND)', example: 300000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  fixed_amount?: number

  @ApiPropertyOptional({ description: '% theo lương cơ bản (0–100)', example: 10.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percent_value?: number

  @ApiPropertyOptional({ description: 'Áp cho ai', example: 'all' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  // 'all' hoặc 'rank:<mã>' — mã rank KHÔNG khoảng trắng/ký tự lạ (khớp đúng rank_code, tránh
  // 'rank: NV' lọt rồi engine bỏ qua âm thầm). rank_code ví dụ: A1/B2/SENIOR_1 (chữ+số+_).
  @Matches(/^(all|rank:[A-Za-z0-9_]+)$/, {
    message: "applies_to phải là 'all' hoặc 'rank:<mã>' (mã không có khoảng trắng)",
  })
  @MaxLength(60)
  applies_to?: string

  @ApiProperty({ description: 'Hiệu lực từ tháng (YYYY-MM)', example: '2026-07' })
  @Matches(MONTH_REGEX, { message: 'effective_from phải dạng YYYY-MM' })
  effective_from!: string

  @ApiPropertyOptional({ description: 'Hiệu lực đến tháng (YYYY-MM)', example: '2026-12' })
  @IsOptional()
  @Matches(MONTH_REGEX, { message: 'effective_to phải dạng YYYY-MM' })
  effective_to?: string

  @ApiPropertyOptional({ description: 'Đang áp dụng', example: true })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_active?: boolean

  @ApiPropertyOptional({ description: 'Chịu thuế TNCN (false = miễn thuế). Mặc định true', example: true })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_taxable?: boolean

  @ApiPropertyOptional({ description: 'Thứ tự hiển thị', example: 0 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  sort_order?: number

  @ApiPropertyOptional({ description: 'Ghi chú' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string
}

export class UpdateSalaryComponentDto extends PartialType(CreateSalaryComponentDto, { skipNullProperties: false }) {}
