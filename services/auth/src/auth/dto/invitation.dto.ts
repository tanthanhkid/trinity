import { IsEmail, IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

/** Chủ công ty mời nhân viên: email + vai trò; trả về link để tự gửi qua Zalo/Messenger. */
export class CreateInvitationDto {
  @ApiProperty({ example: 'nhanvien@example.com' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @MaxLength(255)
  email: string

  @ApiProperty({ description: 'Vai trò gán khi nhận lời mời', example: 2 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  role_id: number
}

export class InvitationTokenDto {
  @ApiProperty({ description: 'Token trong link mời' })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  token: string
}

export class AcceptInvitationDto extends InvitationTokenDto {
  @ApiProperty({ example: 'Nguyễn Văn B' })
  @IsString()
  @MinLength(2, { message: 'Họ tên tối thiểu 2 ký tự' })
  @MaxLength(200)
  full_name: string

  @ApiProperty({ example: 'a-long-password' })
  @IsString()
  @MinLength(8, { message: 'Mật khẩu tối thiểu 8 ký tự' })
  @MaxLength(200)
  password: string
}
