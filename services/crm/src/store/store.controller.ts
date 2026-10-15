import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Can, CurrentUser, Public, type AuthUser } from '@trinity/rbac-nest';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { StoreService } from './store.service';

const clientIp = (req: Request) => (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.ip || '0').replace(/^::ffff:/, '').slice(0, 45);

/** Trang bán hàng online: phần công khai (/store/:slug) + quản trị (cấu hình, đơn). Cờ tổ chức `online_store` (mặc định tắt). */
@ApiTags('Trang bán hàng')
@ApiBearerAuth()
@Controller('store')
export class StoreController {
  constructor(private readonly store: StoreService) {}

  // ─── Quản trị ───

  @Get('settings')
  @Can('pos.manage')
  @RequireOrgFeature('online_store')
  settings() {
    return this.store.settings();
  }

  @Put('settings')
  @Can('pos.manage')
  @RequireOrgFeature('online_store')
  @ApiOperation({ summary: 'Lưu cấu hình trang bán hàng (địa chỉ, giao diện, sản phẩm, cách thanh toán, mở bán)' })
  save(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.store.saveSettings(body ?? {}, user.userId);
  }

  @Get('orders')
  @Can('deals.view')
  @RequireOrgFeature('online_store')
  orders(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.store.listOrders(user, status || undefined, Number(limit) || 50);
  }

  @Patch('orders/:id')
  @Can('deals.manage')
  @RequireOrgFeature('online_store')
  updateOrder(@Param('id', ParseIntPipe) id: number, @Body() body: { status?: string }, @CurrentUser() user: AuthUser) {
    return this.store.updateOrderStatus(user, id, String(body?.status ?? ''));
  }

  // ─── Công khai (khách mua) ───

  @Get('public/:slug')
  @Public()
  @ApiOperation({ summary: 'Thông tin trang + sản phẩm đang bán (công khai)' })
  publicStore(@Param('slug') slug: string) {
    return this.store.publicStore(slug);
  }

  @Post('public/:slug/orders')
  @Public()
  @ApiOperation({ summary: 'Khách đặt đơn (giá lấy từ danh mục; giới hạn 5 đơn/10 phút/IP)' })
  placeOrder(@Param('slug') slug: string, @Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.store.placeOrder(slug, clientIp(req), body as never);
  }

  @Get('public/:slug/orders/:code')
  @Public()
  @ApiOperation({ summary: 'Khách xem trạng thái đơn của mình (cần đúng SĐT)' })
  orderStatus(@Param('slug') slug: string, @Param('code') code: string, @Query('phone') phone: string) {
    return this.store.orderStatus(slug, code, phone);
  }
}
