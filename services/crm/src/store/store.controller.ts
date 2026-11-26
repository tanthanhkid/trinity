import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Can, CurrentUser, Public, resolveClientIp, type AuthUser } from '@trinity/rbac-nest';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { StoreService, type StoreSettings } from './store.service';
import { withCompanyHint } from '../common/helpers/tenant-hint';
import { enterRoutedCompany } from '../common/helpers/routed-company';

/** Multi-tenant: đường dẫn trang công khai kèm `?cid=` khi không phải công ty 1 (web ghép origin vào trước). */
const withPublicPath = (s: StoreSettings) => ({ ...s, public_path: s.slug ? withCompanyHint(`/s/${s.slug}`) : null });

/** Link không mang `?cid=`: chọn công ty theo địa chỉ cửa hàng (slug duy nhất toàn hệ). Có `?cid=` thì giữ nguyên — slug vẫn phải khớp trong công ty đó. */
async function routeBySlug(slug: string): Promise<void> {
  if (!(await enterRoutedCompany('store_slug', slug))) throw new NotFoundException('Không có cửa hàng này.');
}

/**
 * Khoá giới hạn đặt đơn: IP khách (hàm dùng chung, TRUSTED_PROXY; bản cũ lấy phần tử ĐẦU của x-forwarded-for do client
 * tự khai — lỗi, đã bỏ). IP không tin được ⇒ theo số điện thoại người đặt, để khách này không chặn khách khác.
 */
const clientIp = (req: Request, body: Record<string, unknown>) => {
  const c = resolveClientIp(req);
  if (c.ip) return c.ip.slice(0, 45);
  const phone = typeof body?.phone === 'string' ? body.phone.replace(/\D/g, '').slice(0, 20) : '';
  return phone ? `u:phone:${phone}` : c.rateKey.slice(0, 45);
};

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
  async settings() {
    return withPublicPath(await this.store.settings());
  }

  @Put('settings')
  @Can('pos.manage')
  @RequireOrgFeature('online_store')
  @ApiOperation({ summary: 'Lưu cấu hình trang bán hàng (địa chỉ, giao diện, sản phẩm, cách thanh toán, mở bán)' })
  async save(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    const { public_path: _p, ...rest } = body ?? {};
    return withPublicPath(await this.store.saveSettings(rest, user.userId));
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
  async publicStore(@Param('slug') slug: string) {
    await routeBySlug(slug);
    return this.store.publicStore(slug);
  }

  @Post('public/:slug/orders')
  @Public()
  @ApiOperation({ summary: 'Khách đặt đơn (giá lấy từ danh mục; giới hạn 5 đơn/10 phút/IP)' })
  async placeOrder(@Param('slug') slug: string, @Req() req: Request, @Body() body: Record<string, unknown>) {
    await routeBySlug(slug);
    return this.store.placeOrder(slug, clientIp(req, body), body as never);
  }

  @Get('public/:slug/orders/:code')
  @Public()
  @ApiOperation({ summary: 'Khách xem trạng thái đơn của mình (cần đúng SĐT)' })
  async orderStatus(@Param('slug') slug: string, @Param('code') code: string, @Query('phone') phone: string) {
    await routeBySlug(slug);
    return this.store.orderStatus(slug, code, phone);
  }
}
