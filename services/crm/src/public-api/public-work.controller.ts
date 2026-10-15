import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@trinity/rbac-nest';
import { ApiKeyGuard, ApiKeyScopeRequired, type PublicApiRequest } from './api-key.guard';
import { PublicApiRateLimiterGuard } from './public-api-rate-limiter.service';
import { PublicWorkService } from './public-work.service';
import { PublicCreateDealDto, PublicCreateTaskDto } from './dto/public-work.dto';

/**
 * Khoá API cho Zapier / n8n / Make. KHÔNG dùng JWT: `@Public()` chỉ tắt PermissionGuard toàn cục; `ApiKeyGuard`
 * (đúng scope) + rate limit vẫn chạy, và service kiểm quyền của người giữ khoá như màn web.
 */
@ApiTags('Public API')
@ApiHeader({ name: 'X-API-Key', required: true, description: 'Khoá API (Cài đặt › Khoá API)' })
@Controller('public/deals')
@UseGuards(ApiKeyGuard, PublicApiRateLimiterGuard)
@ApiKeyScopeRequired('deals:create')
@Public()
export class PublicDealsController {
  constructor(private readonly svc: PublicWorkService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Tạo thương vụ / đơn; gắn khách theo SĐT (tạo khách mới nếu chưa có và gửi kèm contact_name)' })
  @ApiResponse({ status: 403, description: 'Người giữ khoá không có quyền deals.manage' })
  create(@Body() dto: PublicCreateDealDto, @Req() req: PublicApiRequest) {
    return this.svc.createDeal(dto, req.apiKey);
  }
}

@ApiTags('Public API')
@ApiHeader({ name: 'X-API-Key', required: true, description: 'Khoá API (Cài đặt › Khoá API)' })
@Controller('public/tasks')
@UseGuards(ApiKeyGuard, PublicApiRateLimiterGuard)
@ApiKeyScopeRequired('tasks:create')
@Public()
export class PublicTasksController {
  constructor(private readonly svc: PublicWorkService) {}

  @Get('columns')
  @ApiOperation({ summary: 'Bảng và cột Kanban người giữ khoá được thấy (để chọn column_id)' })
  columns(@Req() req: PublicApiRequest) {
    return this.svc.columns(req.apiKey);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Tạo việc (thẻ Kanban) giao cho người giữ khoá; gắn khách theo SĐT' })
  @ApiResponse({ status: 403, description: 'Người giữ khoá không có quyền kanban.manage' })
  create(@Body() dto: PublicCreateTaskDto, @Req() req: PublicApiRequest) {
    return this.svc.createTask(dto, req.apiKey);
  }
}
