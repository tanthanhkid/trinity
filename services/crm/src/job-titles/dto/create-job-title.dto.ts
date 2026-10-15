import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateIf,
} from 'class-validator'
import { Type } from 'class-transformer'

export class CreateJobTitleDto {
  @ApiProperty({ example: 'Nhân viên', description: 'Nhóm chức danh' })
  @IsNotEmpty()
  @IsString()
  @Length(1, 100)
  category: string

  @ApiProperty({ example: 'CV', description: 'Mã cấp bậc (unique)' })
  @IsNotEmpty()
  @IsString()
  @Length(1, 20)
  rank_code: string

  @ApiProperty({ example: 'Chuyên viên', description: 'Tên đầy đủ' })
  @IsNotEmpty()
  @IsString()
  @Length(1, 100)
  name: string

  @ApiProperty({ example: 'CV', description: 'Ký hiệu ngắn' })
  @IsNotEmpty()
  @IsString()
  @Length(1, 10)
  symbol: string

  @ApiPropertyOptional({ example: 0, description: 'Lương cơ bản (VND)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  base_salary?: number

  @ApiPropertyOptional({ example: 0, description: 'Chỉ tiêu chuẩn (VND)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  standard_target?: number

  @ApiPropertyOptional({
    example: 4500000,
    nullable: true,
    description:
      'Mức đóng BHXH cố định theo chức vụ (VND). null/bỏ trống = dùng lương cơ bản',
  })
  // Body JSON → giá trị tới đã là number|null (KHÔNG @Type để giữ nguyên null, tránh Number(null)=0).
  @ValidateIf(
    (o) =>
      o.default_insurance_salary !== null &&
      o.default_insurance_salary !== undefined,
  )
  @IsInt()
  @Min(0)
  default_insurance_salary?: number | null

  @ApiProperty({ example: 3, description: 'Chu kỳ xét duyệt (tháng)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  review_cycle_months: number

  @ApiPropertyOptional({ example: true, description: 'Còn hiệu lực' })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean

  @ApiPropertyOptional({ example: 10, description: 'Thứ tự hiển thị' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort_order?: number
}
