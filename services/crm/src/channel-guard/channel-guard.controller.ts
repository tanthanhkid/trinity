import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthOnly, Can } from '@trinity/rbac-nest';
import { ChannelGuardService } from './channel-guard.service';

/** Hạn mức kênh, khoá kênh, tạm dừng tự động của công ty — chỉ đọc (khoá/mở do chủ nền tảng bằng CLI). */
@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
export class ChannelGuardController {
  constructor(private readonly guard: ChannelGuardService) {}

  @Get('channel-guard/alerts')
  @AuthOnly()
  @ApiOperation({ summary: 'Cảnh báo kênh gửi ra ngoài (khoá, tạm dừng, sắp hết hạn mức) — cho mọi người dùng đã đăng nhập, chỉ chữ cảnh báo' })
  alerts() {
    return this.guard.alerts();
  }

  @Get('channel-guard')
  @Can('settings.features')
  @ApiOperation({ summary: 'Hạn mức kênh gửi ra ngoài, mức đã dùng, trạng thái khoá/tạm dừng và cảnh báo' })
  status() {
    return this.guard.status();
  }
}
