import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '@trinity/rbac-nest';

@ApiTags('Health')
@Controller()
export class HealthController {
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  health() {
    return { status: 'ok', service: 'crm-service', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness check' })
  ready() {
    return { status: 'ready', service: 'crm-service' };
  }

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness check' })
  live() {
    return { status: 'alive' };
  }
}
