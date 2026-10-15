import { ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsBoolean,
  IsInt,
  IsString,
  Length,
  Min,
  ValidateIf,
} from 'class-validator'
import { Type } from 'class-transformer'

export class UpdateJobTitleDto {
  @ApiPropertyOptional({ example: 'Nhân viên', description: 'Nhóm chức danh' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 100)
  category?: string

  @ApiPropertyOptional({ example: 'Chuyên viên', description: 'Tên đầy đủ' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 100)
  name?: string

  @ApiPropertyOptional({ example: 'CV', description: 'Ký hiệu ngắn' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 10)
  symbol?: string

  @ApiPropertyOptional({ example: 0, description: 'Lương cơ bản (VND)' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  base_salary?: number

  @ApiPropertyOptional({ example: 0, description: 'Chỉ tiêu chuẩn (VND)' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  standard_target?: number

  @ApiPropertyOptional({
    example: 4500000,
    nullable: true,
    description:
      'Mức đóng BHXH cố định theo chức vụ (VND). null = xoá cấu hình → dùng lương cơ bản',
  })
  // Giữ nguyên null để xoá cấu hình (KHÔNG @Type — tránh Number(null)=0).
  @ValidateIf(
    (o) =>
      o.default_insurance_salary !== null &&
      o.default_insurance_salary !== undefined,
  )
  @IsInt()
  @Min(0)
  default_insurance_salary?: number | null

  @ApiPropertyOptional({ example: 3, description: 'Chu kỳ xét duyệt (tháng)' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  review_cycle_months?: number

  @ApiPropertyOptional({ example: true, description: 'Còn hiệu lực' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_active?: boolean

  @ApiPropertyOptional({ example: 10, description: 'Thứ tự hiển thị' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort_order?: number
}
