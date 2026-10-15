import { IsBoolean } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

// công tắc Settings bật/tắt kiểm tra đăng
// nhập theo wifi văn phòng, cần quyền settings.integrations (xem AuthService.updateLoginWifiCheckConfig).
export class UpdateLoginWifiCheckDto {
  @ApiProperty({ description: 'Bật (true) hoặc tắt (false) kiểm tra IP văn phòng khi đăng nhập' })
  @IsBoolean({ message: 'enabled phải là boolean' })
  enabled: boolean
}
