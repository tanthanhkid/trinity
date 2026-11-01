import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

/** Self-service sign-up (multi-tenant mode): creates a new, empty company whose only user is this owner. */
export class RegisterDto {
  @ApiProperty({ example: 'Công ty ABC' })
  @IsString()
  @MinLength(2, { message: 'Tên công ty tối thiểu 2 ký tự' })
  @MaxLength(200)
  company_name: string

  @ApiProperty({ example: 'Nguyễn Văn A' })
  @IsString()
  @MinLength(2, { message: 'Họ tên tối thiểu 2 ký tự' })
  @MaxLength(200)
  full_name: string

  @ApiProperty({ example: 'owner@example.com' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @MaxLength(255)
  email: string

  @ApiProperty({ example: 'a-long-password' })
  @IsString()
  @MinLength(8, { message: 'Mật khẩu tối thiểu 8 ký tự' })
  @MaxLength(200)
  password: string
}
