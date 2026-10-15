import { IsString, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class ResetMyPasswordDto {
  @ApiProperty({ description: 'Mật khẩu hiện tại (xác thực lại trước khi reset)' })
  @IsString()
  @MinLength(1)
  currentPassword: string
}
