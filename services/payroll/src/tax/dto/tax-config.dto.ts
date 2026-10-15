import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger'
import {
  IsInt, IsOptional, IsNumber, IsBoolean, Min, Max, Matches,
  ValidateIf,
} from 'class-validator'

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export class CreateTaxBracketDto {
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) bracket_order!: number
  @ApiProperty({ description: 'Cận dưới thu nhập tính thuế (VNĐ)', example: 0 }) @IsInt() @Min(0) lower_bound!: number
  @ApiPropertyOptional({ description: 'Cận trên (bỏ trống = bậc cao nhất)', example: 5000000 })
  @IsOptional() @IsInt() @Min(0) upper_bound?: number | null
  @ApiProperty({ description: 'Thuế suất (%)', example: 5 }) @IsNumber() @Min(0) @Max(100) rate!: number
  @ApiProperty({ example: '2026-06' }) @Matches(MONTH, { message: 'effective_from phải YYYY-MM' }) effective_from!: string
  @ApiPropertyOptional() @IsOptional() @Matches(MONTH, { message: 'effective_to phải YYYY-MM' }) effective_to?: string
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() is_active?: boolean
}
export class UpdateTaxBracketDto extends PartialType(CreateTaxBracketDto, { skipNullProperties: false }) {}

export class CreateTaxSettingDto {
  @ApiProperty({ description: 'Giảm trừ bản thân (VNĐ)', example: 11000000 }) @IsInt() @Min(0) personal_deduction!: number
  @ApiProperty({ description: 'Giảm trừ mỗi người phụ thuộc (VNĐ)', example: 4400000 }) @IsInt() @Min(0) dependent_deduction!: number
  @ApiProperty({ example: '2026-06' }) @Matches(MONTH, { message: 'effective_from phải YYYY-MM' }) effective_from!: string
  @ApiPropertyOptional() @IsOptional() @Matches(MONTH, { message: 'effective_to phải YYYY-MM' }) effective_to?: string
  @ApiPropertyOptional() @ValidateIf((_o, v) => v !== undefined) @IsBoolean() is_active?: boolean
}
export class UpdateTaxSettingDto extends PartialType(CreateTaxSettingDto, { skipNullProperties: false }) {}
