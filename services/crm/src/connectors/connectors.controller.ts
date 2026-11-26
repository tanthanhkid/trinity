import { Body, Controller, Delete, Get, GoneException, Headers, HttpCode, HttpException, Logger, NotFoundException, Param, ParseIntPipe, Post, Put, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, Public, isPrivateIp, resolveClientIp, type AuthUser } from '@trinity/rbac-nest';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { OrgFeaturesService } from '../settings/org-features.service';
import { SaveMomoDto, SaveSepayDto, SaveVnpayDto } from './connectors.dto';
import type { MomoResult } from './momo';
import { CONNECTOR_PROVIDERS, ConnectorsService, DEFAULT_CODE_PREFIX, type ConnectorProvider, type SepaySettings } from './connectors.service';
import { PaymentsService } from './payments.service';
import { parseSepayTransaction, verifySepayAuth } from './sepay';

/**
 * Connector dịch vụ ngoài (SePay…). Cấu hình = `integrations.webhooks`; yêu cầu thanh toán = quyền deal.
 * Cờ tổ chức `payments` tắt ⇒ 403; riêng webhook luôn trả 200 sau khi kiểm khoá để bên gửi không gửi lại mãi.
 */
@ApiTags('Kết nối dịch vụ ngoài')
@ApiBearerAuth()
@Controller()
export class ConnectorsController {
  private readonly logger = new Logger(ConnectorsController.name);

  constructor(
    private readonly connectors: ConnectorsService,
    private readonly payments: PaymentsService,
    private readonly features: OrgFeaturesService,
  ) {}

  @Get('connectors')
  @Can('integrations.webhooks')
  @RequireOrgFeature('payments')
  @ApiOperation({ summary: 'Trạng thái các connector (không trả khoá)' })
  list() {
    return this.connectors.list();
  }

  @Put('connectors/sepay')
  @Can('integrations.webhooks')
  @RequireOrgFeature('payments')
  @ApiOperation({ summary: 'Lưu cấu hình SePay; lần đầu/rotate_key trả api_key ĐÚNG MỘT LẦN để dán vào webhook SePay' })
  saveSepay(@Body() dto: SaveSepayDto, @CurrentUser() user: AuthUser) {
    return this.connectors.saveSepay(dto as unknown as Record<string, unknown>, user.userId, dto.rotate_key === true);
  }

  @Put('connectors/vnpay')
  @Can('integrations.webhooks')
  @RequireOrgFeature('payments')
  @ApiOperation({ summary: 'Lưu cấu hình VNPay (mã website + chuỗi bí mật do VNPay cấp)' })
  saveVnpay(@Body() dto: SaveVnpayDto, @CurrentUser() user: AuthUser) {
    return this.connectors.saveGateway('vnpay', dto as unknown as Record<string, unknown>, user.userId);
  }

  @Put('connectors/momo')
  @Can('integrations.webhooks')
  @RequireOrgFeature('payments')
  @ApiOperation({ summary: 'Lưu cấu hình MoMo (partner code, access key, secret key do MoMo cấp)' })
  saveMomo(@Body() dto: SaveMomoDto, @CurrentUser() user: AuthUser) {
    return this.connectors.saveGateway('momo', dto as unknown as Record<string, unknown>, user.userId);
  }

  // ─── Link thanh toán công khai (gửi khách) + IPN của cổng ───

  @Get('pay/:code/vnpay')
  @Public()
  @ApiOperation({ summary: 'Link thanh toán VNPay cho khách — chuyển sang cổng VNPay' })
  async payVnpay(@Param('code') code: string, @Req() req: Request, @Res() res: Response) {
    await this.redirectOrPage(res, () => this.payments.vnpayRedirect(code, clientIp(req)));
  }

  @Get('pay/:code/momo')
  @Public()
  @ApiOperation({ summary: 'Link thanh toán MoMo cho khách — tạo giao dịch rồi chuyển sang MoMo' })
  async payMomo(@Param('code') code: string, @Res() res: Response) {
    await this.redirectOrPage(res, () => this.payments.momoRedirect(code));
  }

  @Get('connectors/vnpay/ipn')
  @Public()
  @ApiOperation({ summary: 'IPN VNPay (GET, ký HMAC-SHA512) — trả RspCode theo tài liệu VNPay' })
  async vnpayIpn(@Query() q: Record<string, string>) {
    // Callback đã ký của giao dịch đang dở: vẫn đối soát dù tính năng vừa tắt (khách có thể đã bị trừ tiền).
    try {
      return await this.payments.handleVnpayIpn(q);
    } catch (err) {
      this.logger.error(`VNPay IPN lỗi: ${(err as Error).message}`);
      return { RspCode: '99', Message: 'Unknow error' };
    }
  }

  @Get('pay/vnpay/return')
  @Public()
  async vnpayReturn(@Query() q: Record<string, string>, @Res() res: Response) {
    const r = await this.payments.vnpayReturn(q).catch(() => ({ ok: false, valid: false, code: '' }));
    resultPage(res, r);
  }

  @Post('connectors/momo/ipn')
  @Public()
  @ApiOperation({ summary: 'IPN MoMo (POST JSON, ký HMAC-SHA256) — 204 khi chữ ký đúng' })
  async momoIpn(@Body() body: MomoResult, @Res() res: Response) {
    const out = await this.payments.handleMomoIpn(body);
    if (out.status === 'invalid_signature') return res.status(400).json({ message: 'Invalid signature' });
    return res.status(204).end();
  }

  @Get('pay/momo/return')
  @Public()
  async momoReturn(@Query() q: Record<string, string>, @Res() res: Response) {
    const r = await this.payments.momoReturn(q).catch(() => ({ ok: false, valid: false, code: '' }));
    resultPage(res, r);
  }

  // Route chung đặt CUỐI: Nest khớp theo thứ tự khai báo.
  @Delete('connectors/:provider')
  @Can('integrations.webhooks')
  @RequireOrgFeature('payments')
  @HttpCode(204)
  @ApiOperation({ summary: 'Ngắt một connector (xoá khoá; webhook/IPN cũ bị từ chối)' })
  async disconnect(@Param('provider') provider: string) {
    if (!(CONNECTOR_PROVIDERS as readonly string[]).includes(provider)) throw new NotFoundException('Không có connector này.');
    await this.connectors.disconnect(provider as ConnectorProvider);
  }

  private async redirectOrPage(res: Response, make: () => Promise<string>) {
    // Tắt tính năng ⇒ link đã gửi khách không mở cổng nữa (không tạo giao dịch mới).
    if (!(await this.features.isEnabled('payments'))) return page(res, 403, 'Link thanh toán đã tắt', 'Cửa hàng đã tạm tắt thanh toán trực tuyến. Vui lòng liên hệ cửa hàng.');
    try {
      res.redirect(302, await make());
    } catch (err) {
      const msg = err instanceof HttpException ? err.message : 'Không mở được cổng thanh toán, vui lòng thử lại.';
      if (!(err instanceof HttpException)) this.logger.error(`Mở cổng thanh toán lỗi: ${(err as Error).message}`);
      page(res, err instanceof NotFoundException ? 404 : 400, 'Chưa thanh toán được', msg);
    }
  }

  @Post('connectors/sepay/webhook')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook SePay — header Authorization: Apikey <khoá>' })
  @ApiResponse({ status: 200, description: '{ success: true }' })
  @ApiResponse({ status: 401, description: 'Sai/thiếu khoá hoặc chưa kết nối' })
  async sepayWebhook(@Headers('authorization') auth: string | undefined, @Body() body: unknown) {
    const conn = await this.connectors.active<SepaySettings>('sepay').catch(() => null);
    if (!conn || !verifySepayAuth(auth, conn.credentials.webhook_api_key)) throw new UnauthorizedException('Sai khoá API');
    // Tiền đã về tài khoản: vẫn đối soát dù tính năng đang tắt (khoá đã xác thực) — tắt chỉ chặn tạo yêu cầu/link mới.
    const tx = parseSepayTransaction(body);
    if (!tx) {
      await this.connectors.touch('sepay', 'Nhận dữ liệu SePay sai định dạng');
      return { success: true, ignored: 'invalid_payload' };
    }
    try {
      const out = await this.payments.handleSepay(tx, conn.settings.code_prefix || DEFAULT_CODE_PREFIX);
      return { success: true, result: out.status };
    } catch (err) {
      this.logger.error(`SePay webhook lỗi (tx ${tx.id}): ${(err as Error).message}`);
      throw err; // 500 ⇒ SePay tự gửi lại
    }
  }

  @Get('payments')
  @Can('deals.view')
  @RequireOrgFeature('payments')
  @ApiOperation({ summary: 'Danh sách yêu cầu thanh toán' })
  listPayments(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.payments.list({ status: status || undefined, limit: Number(limit) || undefined }, user);
  }

  /**
   * Ngừng tạo yêu cầu thanh toán mới (G07a, #105). Yêu cầu ĐANG CHỜ vẫn được ghi nhận: IPN VNPay/MoMo, trang trả về và
   * webhook SePay vẫn chạy (các route ở trên), danh sách/xem/huỷ vẫn dùng được.
   */
  // Không kiểm quyền/công tắc: MỌI caller (kể cả chưa đăng nhập, tính năng tắt) nhận cùng một câu 410 rõ ràng.
  @Post('payments')
  @Public()
  @HttpCode(410)
  @ApiOperation({ summary: 'Đã ngừng: Trinity không tạo yêu cầu thanh toán mới (trả 410); yêu cầu đang chờ vẫn được ghi nhận khi tiền về' })
  create(): never {
    throw new GoneException(PAYMENT_CREATION_STOPPED);
  }

  @Get('payments/:id')
  @Can('deals.view')
  @RequireOrgFeature('payments')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.payments.get(id, user);
  }

  @Post('payments/:id/cancel')
  @Can('deals.manage')
  @RequireOrgFeature('payments')
  @HttpCode(200)
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.payments.cancel(id, user);
  }
}

export const PAYMENT_CREATION_STOPPED =
  'Trinity đã ngừng tạo yêu cầu thanh toán mới. Các yêu cầu đang chờ vẫn được tự đánh dấu đã trả khi tiền về; nhận tiền mới bằng QR chuyển khoản của ngân hàng hoặc công cụ của cổng thanh toán.';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * IP khách cho VNPay (`vnp_IpAddr`): chỉ IP khách tin được và công khai. Không tin được, hoặc là địa chỉ nội bộ ⇒ chuỗi
 * rỗng (vnpay.ts dùng giá trị mặc định), KHÔNG gửi IP proxy/container của mình.
 */
function clientIp(req: Request): string {
  const ip = resolveClientIp(req).ip;
  return ip && !isPrivateIp(ip) ? ip.slice(0, 45) : '';
}

/** Trang kết quả gọn cho khách (không cần đăng nhập, không lộ dữ liệu CRM). */
function page(res: Response, status: number, title: string, body: string) {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
        `<style>body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f7f7f8;color:#16181d;display:grid;place-items:center;min-height:100vh}` +
        `main{background:#fff;border-radius:16px;padding:32px 28px;max-width:380px;margin:16px;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#5b616e}</style></head>` +
        `<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`,
    );
}

function resultPage(res: Response, r: { ok: boolean; valid: boolean; code: string }) {
  if (!r.valid) return page(res, 400, 'Không xác nhận được kết quả', 'Dữ liệu trả về từ cổng thanh toán không hợp lệ. Nếu bạn đã bị trừ tiền, hãy liên hệ cửa hàng kèm mã giao dịch.');
  if (r.ok) return page(res, 200, 'Thanh toán thành công', `Cảm ơn bạn. Cửa hàng đã nhận thông tin thanh toán cho mã ${r.code}.`);
  return page(res, 200, 'Thanh toán chưa thành công', `Giao dịch cho mã ${r.code} chưa hoàn tất. Bạn có thể mở lại link thanh toán để thử lần nữa.`);
}
