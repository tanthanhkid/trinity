import { IsOptional, IsString } from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'

export class LogoutDto {
  @ApiPropertyOptional({ description: 'Refresh token của phiên đang đăng xuất — được thu hồi phía máy chủ' })
  @IsOptional()
  @IsString({ message: 'Refresh token phải là chuỗi' })
  refresh_token?: string
}
