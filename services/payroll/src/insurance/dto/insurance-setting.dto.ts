import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger'
import {
  IsString, IsNotEmpty, IsOptional, IsInt, IsNumber, IsBoolean,
  Min, Max, MaxLength, Matches,
  ValidateIf,
} from 'class-validator'

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/

export class CreateInsuranceSettingDto {
  @ApiProperty({ description: 'Tên', example: 'Bảo hiểm xã hội (BHXH)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string

  @ApiProperty({ description: 'Mã (slug)', example: 'bhxh' })
  @IsString()
  @Matches(/^[a-z0-9_]+$/, { message: 'Mã chỉ gồm chữ thường, số, gạch dưới' })
  @MaxLength(40)
  code!: string

  @ApiProperty({ description: 'Tỷ lệ NLĐ đóng (%) 0–100', example: 8 })
  @IsNumber()
  @Min(0)
  @Max(100)
  employee_rate!: number

  @ApiPropertyOptional({ description: 'Trần lương đóng BH (VNĐ); bỏ trống = không trần', example: 46800000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  base_cap?: number | null

  @ApiProperty({ description: 'Hiệu lực từ tháng (YYYY-MM)', example: '2024-07' })
  @Matches(MONTH_REGEX, { message: 'effective_from phải dạng YYYY-MM' })
  effective_from!: string

  @ApiPropertyOptional({ description: 'Hiệu lực đến tháng (YYYY-MM)' })
  @IsOptional()
  @Matches(MONTH_REGEX, { message: 'effective_to phải dạng YYYY-MM' })
  effective_to?: string

  @ApiPropertyOptional({ description: 'Đang áp dụng' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_active?: boolean

  @ApiPropertyOptional({ description: 'Thứ tự' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  sort_order?: number
}

export class UpdateInsuranceSettingDto extends PartialType(CreateInsuranceSettingDto, { skipNullProperties: false }) {}
