import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '@trinity/rbac-nest';
import { ApiKeyGuard, ApiKeyScopeRequired, ValidatedApiKey, PublicApiRequest } from './api-key.guard';
import { PublicApiService } from './public-api.service';
import { PublicApiRateLimiterGuard } from './public-api-rate-limiter.service';
import { PublicCreateContactDto } from './dto/public-create-contact.dto';

/**
 * RBAC quyền + phạm vi: endpoint này KHÔNG dùng JWT — xác thực bằng
 * `ApiKeyGuard` (khoá `X-API-Key` riêng của bên thứ 3). `@Public()` chỉ tắt
 * `PermissionGuard` toàn cục (deny-by-default khi thiếu metadata `@Can`/
 * `@AuthOnly`/`@Public`/`@Internal`) — `ApiKeyGuard` + `PublicApiRateLimiterGuard`
 * ở `@UseGuards` bên dưới VẪN CHẠY bình thường, đây KHÔNG phải mở endpoint ra
 * public thật.
 */
@ApiTags('Public API')
@Controller('public/contacts')
@UseGuards(ApiKeyGuard, PublicApiRateLimiterGuard)
@ApiKeyScopeRequired('contacts:create')
@Public()
export class PublicContactsController {
  constructor(private readonly svc: PublicApiService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'X-API-Key',
    required: true,
    description: 'Khoá API (scope contacts:create)',
  })
  @ApiOperation({
    summary: 'Tạo khách hàng (contact) qua API key',
    description:
      'Bên thứ 3 gửi thông tin khách hàng tiềm năng. Contact được gán ' +
      '`assigned_to = owner_user_id` của khoá. Cho phép SĐT trùng — trả `warning`.',
  })
  @ApiResponse({ status: 201, description: 'Tạo thành công' })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 401, description: 'X-API-Key sai hoặc không có scope' })
  async create(@Body() dto: PublicCreateContactDto, @Req() req: PublicApiRequest) {
    const apiKey: ValidatedApiKey = req.apiKey;
    return this.svc.createContact(dto, apiKey);
  }

  @Get('sources')
  @ApiHeader({ name: 'X-API-Key', required: true, description: 'Khoá API (scope contacts:create)' })
  @ApiOperation({ summary: 'Nguồn khách đang bật — dùng cho source_id / contact_source_id' })
  sources() {
    return this.svc.listSources();
  }
}
