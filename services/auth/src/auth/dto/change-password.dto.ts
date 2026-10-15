import { IsString, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class ChangePasswordDto {
  @ApiProperty({ description: 'Mật khẩu hiện tại' })
  @IsString()
  currentPassword: string

  @ApiProperty({ description: 'Mật khẩu mới (tối thiểu 8 ký tự)' })
  @IsString()
  @MinLength(8, { message: 'Mật khẩu mới tối thiểu 8 ký tự' })
  newPassword: string
}
