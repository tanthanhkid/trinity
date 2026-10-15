import { Controller, Get } from '@nestjs/common'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import { Public } from '@trinity/rbac-nest'

// Route "chết" trong monolith (auth's HealthController đăng ký trước, thắng
// /api/v1/health) nhưng boot-check duyệt MỌI controller qua DiscoveryService
// bất kể có thắng route hay không — vẫn cần @Public() để qua PermissionGuard (deny-by-default).
@ApiTags('Health')
@Controller()
export class HealthController {
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  health() {
    return { status: 'ok', service: 'notification-service', timestamp: new Date().toISOString() }
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness check' })
  ready() {
    return { status: 'ready', service: 'notification-service' }
  }

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness check' })
  live() {
    return { status: 'alive' }
  }
}
