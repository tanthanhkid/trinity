import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { integrationFlags } from '@trinity/prisma';
import { CreateInboundSourceDto, UpdateInboundSourceDto } from './dto-inbound-source';
import { WebhookInboundSourcesService } from './webhook-inbound-sources.service';

const assertEnabled = (): void => {
  if (!integrationFlags.webhooksEnabled()) throw new NotFoundException();
};

/**
 * Quản trị nguồn webhook vào. Xem/xoá/tắt: `integrations.webhooks`. Tạo/sửa/tạo lại token: THÊM `contacts.create`
 * (nguồn tạo khách thay mặt người cấu hình ⇒ không cấp thứ mình không có) + người nhận phải nằm trong `contacts.transfer`.
 * Token / signing secret chỉ trả ở phản hồi tạo / tạo lại.
 */
@ApiTags('Integrations — Webhook vào')
@ApiBearerAuth()
@Controller('integrations/webhooks/inbound-sources')
export class WebhookInboundSourcesController {
  constructor(private readonly sources: WebhookInboundSourcesService) {}

  @Get()
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Danh sách nguồn webhook vào (không có token)' })
  async list() {
    assertEnabled();
    return { data: await this.sources.list() };
  }

  @Post()
  @Can('integrations.webhooks', 'contacts.create')
  @ApiOperation({ summary: 'Tạo nguồn — trả `token` + `path` (+ `signing_secret`) DUY NHẤT một lần' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 503, description: 'Chưa cấu hình INTEGRATIONS_SECRET_KEY' })
  create(@Body() dto: CreateInboundSourceDto, @CurrentUser() user: AuthUser) {
    assertEnabled();
    return this.sources.create(dto, user);
  }

  @Get(':id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Chi tiết nguồn' })
  get(@Param('id', ParseIntPipe) id: number) {
    assertEnabled();
    return this.sources.get(id);
  }

  @Patch(':id')
  @Can('integrations.webhooks', 'contacts.create')
  @ApiOperation({ summary: 'Sửa nguồn (tên, người nhận, nguồn khách, dự án, bật/tắt, bật/tắt chữ ký)' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateInboundSourceDto, @CurrentUser() user: AuthUser) {
    assertEnabled();
    return this.sources.update(id, dto, user);
  }

  @Post(':id/rotate-token')
  @HttpCode(HttpStatus.OK)
  @Can('integrations.webhooks', 'contacts.create')
  @ApiOperation({ summary: 'Tạo lại token — URL cũ vô hiệu ngay; trả token mới MỘT lần' })
  rotate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    assertEnabled();
    return this.sources.rotateToken(id, user);
  }

  @Delete(':id')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Xoá nguồn' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    assertEnabled();
    return this.sources.remove(id, user);
  }
}
