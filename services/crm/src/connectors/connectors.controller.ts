import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Logger, NotFoundException, Param, ParseIntPipe, Post, Put, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, Public, type AuthUser } from '@trinity/rbac-nest';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { OrgFeaturesService } from '../settings/org-features.service';
import { CreatePaymentDto, SaveKiotVietDto, SaveMisaDto, SaveSapoDto, SaveWooDto, SaveMomoDto, SaveSepayDto, SaveVnpayDto } from './connectors.dto';
import { KiotVietService } from './kiotviet.service';
import { SapoService } from './sapo.service';
import { MisaService } from './misa.service';
import { WooCommerceService } from './woocommerce.service';
import { ShopeeService } from './shopee.service';
import { LazadaService } from './lazada.service';
import { publicBaseUrl } from '../integrations/oauth/oauth-config';
import { CommerceSyncService } from './commerce-sync.service';
import type { KvWebhookBody } from './kiotviet';
import { PrismaService } from '@trinity/prisma';
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
    private readonly kiotviet: KiotVietService,
    private readonly prisma: PrismaService,
    private readonly commerce: CommerceSyncService,
    private readonly sapo: SapoService,
    private readonly misa: MisaService,
    private readonly woo: WooCommerceService,
    private readonly shopee: ShopeeService,
    private readonly lazada: LazadaService,
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

  @Delete('connectors/kiotviet')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(204)
  @ApiOperation({ summary: 'Ngắt KiotViet (gỡ webhook, xoá khoá; dữ liệu đã đồng bộ vẫn giữ)' })
  async disconnectKiotViet() {
    await this.kiotviet.disconnect();
  }

  // ─── Phần mềm bán hàng (KiotViet…) ───

  @Get('connectors/commerce')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @ApiOperation({ summary: 'Trạng thái connector bán hàng (KiotViet…) — không phụ thuộc tính năng Thanh toán' })
  async salesConnectors() {
    return (await this.connectors.list()).filter((c) => c.provider === 'kiotviet' || c.provider === 'sapo' || c.provider === 'misa' || c.provider === 'woocommerce' || c.provider === 'shopee' || c.provider === 'lazada');
  }

  @Put('connectors/kiotviet')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @ApiOperation({ summary: 'Kết nối KiotViet: kiểm khoá bằng token thật, đăng ký webhook, đồng bộ lần đầu (90 ngày)' })
  saveKiotViet(@Body() dto: SaveKiotVietDto, @CurrentUser() user: AuthUser) {
    return this.kiotviet.connect(dto, user.userId);
  }

  @Post('connectors/kiotviet/sync')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đồng bộ tiếp khách, hàng, đơn, hoá đơn từ KiotViet (tối đa 300 bản ghi mỗi loại mỗi lần)' })
  syncKiotViet() {
    return this.kiotviet.runSync();
  }

  @Post('connectors/kiotviet/webhook/:token')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook KiotViet (X-Hub-Signature HMAC-SHA256)' })
  async kiotvietWebhook(@Param('token') token: string, @Req() req: Request, @Headers('x-hub-signature') sig: string | undefined, @Body() body: KvWebhookBody) {
    if (!(await this.features.isEnabled('commerce_connectors'))) return { ok: true, ignored: 'feature_off' };
    const out = await this.kiotviet.handleWebhook(token, (req as Request & { rawBody?: Buffer }).rawBody, sig, body);
    if (!out.ok) throw new UnauthorizedException('Sai chữ ký');
    return out;
  }

  @Put('connectors/sapo')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @ApiOperation({ summary: 'Kết nối Sapo (ứng dụng riêng): kiểm khoá, đăng ký webhook, đồng bộ lần đầu (90 ngày)' })
  saveSapo(@Body() dto: SaveSapoDto, @CurrentUser() user: AuthUser) {
    return this.sapo.connect(dto, user.userId);
  }

  @Post('connectors/sapo/sync')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đồng bộ tiếp khách, hàng, đơn từ Sapo' })
  syncSapo() {
    return this.sapo.runSync();
  }

  @Delete('connectors/sapo')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(204)
  @ApiOperation({ summary: 'Ngắt Sapo (gỡ webhook, xoá khoá; dữ liệu đã đồng bộ vẫn giữ)' })
  async disconnectSapo() {
    await this.sapo.disconnect();
  }

  @Post('connectors/sapo/webhook/:token')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook Sapo — token đường dẫn (+ HMAC nếu có); bản ghi đọc lại từ API Sapo' })
  async sapoWebhook(
    @Param('token') token: string,
    @Req() req: Request,
    @Headers('x-sapo-topic') topicHeader: string | undefined,
    @Query('topic') topicQuery: string | undefined,
    @Headers('x-sapo-hmac-sha256') hmac: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (!(await this.features.isEnabled('commerce_connectors'))) return { ok: true, ignored: 'feature_off' };
    const out = await this.sapo.handleWebhook(token, topicHeader || topicQuery, (req as Request & { rawBody?: Buffer }).rawBody, hmac, body);
    if (!out.ok) throw new UnauthorizedException('Sai mã webhook');
    return out;
  }

  @Put('connectors/misa')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @ApiOperation({ summary: 'Kết nối MISA AMIS Kế toán (mã kết nối + mã công ty), đồng bộ khách + hàng hoá' })
  saveMisa(@Body() dto: SaveMisaDto, @CurrentUser() user: AuthUser) {
    return this.misa.connect(dto, user.userId);
  }

  @Post('connectors/misa/sync')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đồng bộ tiếp khách + hàng hoá từ MISA (MISA không có webhook)' })
  syncMisa() {
    return this.misa.runSync();
  }

  @Delete('connectors/misa')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(204)
  async disconnectMisa() {
    await this.connectors.disconnect('misa');
  }

  @Put('connectors/woocommerce')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @ApiOperation({ summary: 'Kết nối WooCommerce (REST API key): kiểm khoá, đăng ký webhook, đồng bộ lần đầu (90 ngày)' })
  saveWoo(@Body() dto: SaveWooDto, @CurrentUser() user: AuthUser) {
    return this.woo.connect(dto, user.userId);
  }

  @Post('connectors/woocommerce/sync')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(200)
  syncWoo() {
    return this.woo.runSync();
  }

  @Delete('connectors/woocommerce')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(204)
  async disconnectWoo() {
    await this.woo.disconnect();
  }

  @Post('connectors/woocommerce/webhook/:token')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook WooCommerce (X-WC-Webhook-Signature HMAC-SHA256 base64)' })
  async wooWebhook(
    @Param('token') token: string,
    @Req() req: Request,
    @Headers('x-wc-webhook-topic') topic: string | undefined,
    @Headers('x-wc-webhook-signature') sig: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (!(await this.features.isEnabled('commerce_connectors'))) return { ok: true, ignored: 'feature_off' };
    const out = await this.woo.handleWebhook(token, topic, (req as Request & { rawBody?: Buffer }).rawBody, sig, body);
    if (!out.ok) throw new UnauthorizedException('Sai chữ ký');
    return out;
  }

  // ─── Sàn TMĐT (Shopee, Lazada): OAuth của sàn ───

  @Post('connectors/:market/connect')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bắt đầu cấp quyền shop Shopee/Lazada — trả URL chuyển sang sàn' })
  marketConnect(@Param('market') market: string, @CurrentUser() user: AuthUser) {
    if (market === 'shopee') return this.shopee.startConnect(user.userId);
    if (market === 'lazada') return this.lazada.startConnect(user.userId);
    throw new NotFoundException('Không có sàn này.');
  }

  @Get('connectors/shopee/callback')
  @Public()
  async shopeeCallback(@Query('code') code: string, @Query('shop_id') shopId: string, @Query('state') state: string, @Res() res: Response) {
    await this.marketBack(res, () => this.shopee.completeConnect(code, shopId, state));
  }

  @Get('connectors/lazada/callback')
  @Public()
  async lazadaCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    await this.marketBack(res, () => this.lazada.completeConnect(code, state));
  }

  @Post('connectors/:market/sync')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(200)
  marketSync(@Param('market') market: string) {
    if (market === 'shopee') return this.shopee.runSync();
    if (market === 'lazada') return this.lazada.runSync();
    throw new NotFoundException('Không có sàn này.');
  }

  @Delete('connectors/shopee')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(204)
  async disconnectShopee() {
    await this.connectors.disconnect('shopee');
  }

  @Delete('connectors/lazada')
  @Can('integrations.webhooks')
  @RequireOrgFeature('commerce_connectors')
  @HttpCode(204)
  async disconnectLazada() {
    await this.connectors.disconnect('lazada');
  }

  @Post('connectors/shopee/push')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Push Shopee (Authorization = HMAC-SHA256(partner_key, url|body))' })
  async shopeePush(@Req() req: Request, @Headers('authorization') auth: string | undefined, @Body() body: Record<string, unknown>) {
    if (!(await this.features.isEnabled('commerce_connectors'))) return {};
    const base = publicBaseUrl() ?? '';
    const out = await this.shopee.handlePush(`${base}/api/v1/connectors/shopee/push`, (req as Request & { rawBody?: Buffer }).rawBody, auth, body as never);
    if (!out.ok) throw new UnauthorizedException('Sai chữ ký');
    return {};
  }

  @Post('connectors/lazada/push')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Push Lazada (Authorization = HMAC-SHA256(app_secret, app_key + body))' })
  async lazadaPush(@Req() req: Request, @Headers('authorization') auth: string | undefined, @Body() body: Record<string, unknown>) {
    if (!(await this.features.isEnabled('commerce_connectors'))) return {};
    const out = await this.lazada.handlePush((req as Request & { rawBody?: Buffer }).rawBody, auth, body as never);
    if (!out.ok) throw new UnauthorizedException('Sai chữ ký');
    return {};
  }

  @Get('connectors/records')
  @Can('deals.view')
  @RequireOrgFeature('commerce_connectors')
  @ApiOperation({ summary: 'Bản ghi đã đồng bộ (khách/đơn/hoá đơn/hàng) từ phần mềm bán hàng' })
  async records(@CurrentUser() user: AuthUser, @Query('provider') provider?: string, @Query('kind') kind?: string, @Query('limit') limit?: string) {
    const rows = await this.prisma.connectorRecord.findMany({
      where: { AND: [{ ...(provider ? { provider } : {}), ...(kind ? { kind } : {}) }, await this.commerce.scopeWhere(user)] },
      orderBy: [{ external_updated_at: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: Math.min(Math.max(Number(limit) || 50, 1), 200),
    });
    return rows.map((r) => ({ ...r, amount: r.amount == null ? null : Number(r.amount) }));
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

  // Route chung đặt CUỐI: Nest khớp theo thứ tự khai báo, đặt trước thì nuốt mất route ngắt riêng (kiotviet, sapo…).
  @Delete('connectors/:provider')
  @Can('integrations.webhooks')
  @RequireOrgFeature('payments')
  @HttpCode(204)
  @ApiOperation({ summary: 'Ngắt một connector (xoá khoá; webhook/IPN cũ bị từ chối)' })
  async disconnect(@Param('provider') provider: string) {
    if (!(CONNECTOR_PROVIDERS as readonly string[]).includes(provider)) throw new NotFoundException('Không có connector này.');
    await this.connectors.disconnect(provider as ConnectorProvider);
  }

  /** Về lại Cài đặt sau khi cấp quyền sàn, kèm kết quả. */
  private async marketBack(res: Response, done: () => Promise<void>) {
    const back = `${publicBaseUrl() ?? ''}/connections?muc=ban-hang`;
    try {
      await done();
      res.redirect(302, `${back}&ket_noi=ok`);
    } catch (err) {
      this.logger.warn(`Cấp quyền sàn lỗi: ${(err as Error).message}`);
      res.redirect(302, `${back}&ket_noi=loi&ly_do=${encodeURIComponent((err as Error).message.slice(0, 160))}`);
    }
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

  @Post('payments')
  @Can('deals.manage')
  @RequireOrgFeature('payments')
  @ApiOperation({ summary: 'Tạo yêu cầu thanh toán (mã + QR chuyển khoản khi đã nối SePay)' })
  create(@Body() dto: CreatePaymentDto, @CurrentUser() user: AuthUser) {
    return this.payments.create(dto, user.userId);
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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** IP khách (sau proxy) — VNPay bắt buộc vnp_IpAddr. */
function clientIp(req: Request): string {
  const xf = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return (xf || req.ip || '127.0.0.1').replace(/^::ffff:/, '').slice(0, 45);
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
