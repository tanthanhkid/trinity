import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { INTEGRATION_EVENT_META } from '@trinity/prisma';
import { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from './dto/webhook-endpoint.dto';
import { QueryWebhookDeliveriesDto } from './dto/query-deliveries.dto';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { WebhookDeliveriesService } from './webhook-deliveries.service';

/**
 * Webhook RA. Mọi route cần `integrations.webhooks` (không scoped — quản trị toàn công ty) và cờ
 * `INTEGRATIONS_WEBHOOKS_ENABLED` (tắt → 404). `secret` chỉ xuất hiện ở phản hồi tạo / tạo lại secret.
 */
@ApiTags('Integrations — Webhook ra')
@ApiBearerAuth()
@Controller('integrations/webhooks')
export class WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly deliveries: WebhookDeliveriesService,
  ) {}

  @Get('events')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Danh mục sự kiện có thể đăng ký' })
  @ApiResponse({ status: 200, description: '[{ type, resource, label }]' })
  @ApiResponse({ status: 404, description: 'Webhook chưa được bật trên máy chủ' })
  events() {
    this.endpoints.assertEnabled();
    return Object.entries(INTEGRATION_EVENT_META).map(([type, m]) => ({ type, resource: m.resource, label: m.label }));
  }

  @Get('endpoints')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Danh sách endpoint' })
  @ApiResponse({ status: 200 })
  async list() {
    this.endpoints.assertEnabled();
    return { data: await this.endpoints.list() };
  }

  @Post('endpoints')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Tạo endpoint — trả `secret` DUY NHẤT một lần' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 400, description: 'URL bị chặn (SSRF) / dữ liệu sai / quá 20 endpoint' })
  @ApiResponse({ status: 503, description: 'Chưa cấu hình INTEGRATIONS_SECRET_KEY' })
  create(@Body() dto: CreateWebhookEndpointDto, @CurrentUser() user: AuthUser) {
    this.endpoints.assertEnabled();
    return this.endpoints.create(dto, user.userId);
  }

  @Get('endpoints/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Chi tiết endpoint (không có secret)' })
  get(@Param('id', ParseIntPipe) id: number) {
    this.endpoints.assertEnabled();
    return this.endpoints.get(id);
  }

  @Patch('endpoints/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Sửa endpoint (tên, URL, sự kiện, bật/tắt)' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateWebhookEndpointDto, @CurrentUser() user: AuthUser) {
    this.endpoints.assertEnabled();
    return this.endpoints.update(id, dto, user.userId);
  }

  @Delete('endpoints/:id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Xoá endpoint cùng lịch sử gửi' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    this.endpoints.assertEnabled();
    return this.endpoints.remove(id, user.userId);
  }

  @Post('endpoints/:id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Tạo lại secret — secret cũ hết hiệu lực ngay; trả secret mới MỘT lần' })
  rotate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    this.endpoints.assertEnabled();
    return this.endpoints.rotateSecret(id, user.userId);
  }

  @Post('endpoints/:id/test')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Gửi sự kiện `ping` thử (đồng bộ, 1 lần)' })
  @ApiResponse({ status: 200, description: '{ delivery_id, ok, status_code, error, duration_ms }' })
  test(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    this.endpoints.assertEnabled();
    return this.endpoints.test(id, user.userId);
  }

  @Get('deliveries')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Nhật ký gửi (mới → cũ, cursor). Không trả payload.' })
  async deliveriesList(@Query() q: QueryWebhookDeliveriesDto) {
    this.endpoints.assertEnabled();
    const { data, next_cursor } = await this.deliveries.list(q);
    return { data, meta: { next_cursor } };
  }

  @Post('deliveries/:id/retry')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Gửi lại một lượt đã lỗi/đã dừng' })
  retry(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    this.endpoints.assertEnabled();
    return this.endpoints.retryDelivery(id, user.userId);
  }
}
