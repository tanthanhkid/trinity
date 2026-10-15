import { IsBoolean } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

// công tắc Settings bật/tắt "mỗi tài khoản chỉ 1 phiên đăng
// nhập" (đăng nhập mới đá phiên cũ), cần quyền settings.integrations (xem
// AuthService.updateSingleSessionConfig).
export class UpdateSingleSessionDto {
  @ApiProperty({ description: 'Bật (true) hoặc tắt (false) giới hạn 1 phiên đăng nhập/tài khoản' })
  @IsBoolean({ message: 'enabled phải là boolean' })
  enabled: boolean
}
