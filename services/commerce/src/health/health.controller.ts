import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '@trinity/rbac-nest';

@ApiTags('Health')
@Public()
@Controller()
export class HealthController {
  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  health() {
    return { status: 'ok', service: 'commerce-service', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness check' })
  ready() {
    return { status: 'ready', service: 'commerce-service' };
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness check' })
  live() {
    return { status: 'alive' };
  }
}
