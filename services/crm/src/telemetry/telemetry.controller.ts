import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthOnly, CurrentUser, Public, type AuthUser } from '@trinity/rbac-nest';
import { hashUserId, hashingEnabled } from '@trinity/logger';
import { buildTelemetryConfig } from './telemetry-config';

/** Cấu hình giám sát cho web + mã định danh đã băm của người dùng (không bao giờ trả id thật). */
@ApiTags('Telemetry')
@Controller('telemetry')
export class TelemetryController {
  @Public()
  @Get('config')
  @ApiOperation({ summary: 'Cấu hình Sentry/PostHog cho trình duyệt (null khi chưa bật)' })
  config() {
    return buildTelemetryConfig();
  }

  @AuthOnly()
  @Get('identity')
  @ApiOperation({ summary: 'Mã người dùng đã băm HMAC để gắn vào Sentry/PostHog' })
  identity(@CurrentUser() user: AuthUser) {
    return { user: hashingEnabled() ? hashUserId(user.userId) : null };
  }
}
