import { IsString, IsOptional, Matches, MinLength, MaxLength, ValidateIf } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class UpdateProfileDto {
  @ApiProperty({ description: 'Họ tên', required: false })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(2, { message: 'Họ tên tối thiểu 2 ký tự' })
  @MaxLength(100, { message: 'Họ tên tối đa 100 ký tự' })
  full_name?: string

  @ApiProperty({ description: 'Số điện thoại', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^(0|\+84)\d{9}$/, { message: 'Số điện thoại không hợp lệ (VD: 0912345678)' })
  phone?: string
}
