import { Controller, Get } from '@nestjs/common'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import { Public } from '@trinity/rbac-nest'

@ApiTags('Health')
@Controller()
export class HealthController {
  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Health check' })
  health() {
    return { status: 'ok', service: 'auth-service', timestamp: new Date().toISOString() }
  }

  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Readiness check' })
  ready() {
    return { status: 'ready', service: 'auth-service' }
  }

  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Liveness check' })
  live() {
    return { status: 'alive' }
  }
}
