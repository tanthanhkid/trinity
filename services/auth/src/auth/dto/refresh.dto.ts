import { IsString } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class RefreshDto {
  @ApiProperty({ description: 'Refresh token nhận từ login/refresh' })
  @IsString({ message: 'Refresh token phải là chuỗi' })
  refresh_token: string
}
