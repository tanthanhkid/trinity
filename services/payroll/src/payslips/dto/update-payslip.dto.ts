import { ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator'

// Số tiền VNĐ: số nguyên không âm dạng chuỗi (BigInt), tối đa 15 chữ số.
const MONEY_REGEX = /^\d{1,15}$/
const MONEY_MSG = 'phải là số nguyên không âm (VNĐ)'

/**
 * Sửa phiếu lương theo mẫu kế toán. Tất cả trường optional (partial update).
 * Money truyền dưới dạng chuỗi số nguyên (BigInt) để tránh mất chính xác.
 */
export class UpdatePayslipDto {
  @ApiPropertyOptional({ description: 'Ngày công thực tế (null = bỏ, tính nguyên lương)', example: 23.5 })
  @IsOptional()
  @ValidateIf((o) => o.working_days !== null && o.working_days !== undefined)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(31)
  working_days?: number | null

  @ApiPropertyOptional({ description: 'Ngày công chuẩn để prorate', example: 26 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  standard_working_days?: number

  @ApiPropertyOptional({ description: 'Ngày học việc (passthrough, null = bỏ)', example: 10 })
  @IsOptional()
  @ValidateIf((o) => o.training_days !== null && o.training_days !== undefined)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(31)
  training_days?: number | null

  @ApiPropertyOptional({ description: 'Lương cơ bản (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `base_salary ${MONEY_MSG}` })
  base_salary?: string

  @ApiPropertyOptional({ description: 'Lương học việc (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `training_salary ${MONEY_MSG}` })
  training_salary?: string

  @ApiPropertyOptional({ description: 'Phụ cấp học việc (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `probation_allowance ${MONEY_MSG}` })
  probation_allowance?: string

  @ApiPropertyOptional({ description: 'Doanh số cá nhân — tham chiếu (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `sales_personal ${MONEY_MSG}` })
  sales_personal?: string

  @ApiPropertyOptional({ description: 'Hệ số % bonus DS cá nhân (vd 0.4 = 0.4%); null = không dùng', example: 0.4 })
  @IsOptional()
  @ValidateIf((o) => o.bonus_rate !== null && o.bonus_rate !== undefined)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  bonus_rate?: number | null

  @ApiPropertyOptional({ description: 'Tỷ lệ KPI đạt được (%) — nhập tay; null = không nhập', example: 85.5 })
  @IsOptional()
  @ValidateIf((o) => o.kpi_percent !== null && o.kpi_percent !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999.99)
  kpi_percent?: number | null

  @ApiPropertyOptional({ description: 'Bonus doanh số cá nhân (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `bonus_sales_personal ${MONEY_MSG}` })
  bonus_sales_personal?: string

  @ApiPropertyOptional({ description: 'Doanh số Team — tham chiếu (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `sales_team ${MONEY_MSG}` })
  sales_team?: string

  @ApiPropertyOptional({ description: 'Thưởng CSKH / Bonus Team (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `bonus_cskh_team ${MONEY_MSG}` })
  bonus_cskh_team?: string

  @ApiPropertyOptional({ description: 'Thưởng mốc cá nhân / Vượt mốc (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `bonus_milestone ${MONEY_MSG}` })
  bonus_milestone?: string

  @ApiPropertyOptional({ description: 'Thưởng giới thiệu ứng viên / Contest (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `bonus_referral ${MONEY_MSG}` })
  bonus_referral?: string

  @ApiPropertyOptional({ description: 'Thưởng Lễ (VNĐ) — cộng vào tổng doanh số & thưởng' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `holiday_bonus ${MONEY_MSG}` })
  holiday_bonus?: string

  @ApiPropertyOptional({ description: 'Các khoản đã chi lĩnh trước (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `advances ${MONEY_MSG}` })
  advances?: string

  @ApiPropertyOptional({ description: 'Thuế TNCN nhập tay — kế toán nhập ghi đè hệ thống tự tính (VNĐ)' })
  @IsOptional()
  @Matches(MONEY_REGEX, { message: `personal_income_tax ${MONEY_MSG}` })
  personal_income_tax?: string

  @ApiPropertyOptional({ description: 'Ghi chú phiếu lương' })
  @IsOptional()
  @ValidateIf((o) => o.notes !== null && o.notes !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string | null
}
