import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import { Can, CurrentUser, Public, type AuthUser } from '@trinity/rbac-nest';
import { isSecretKeyConfigured } from '../integrations/webhooks/secret-crypto';
import { CreateSyncDto, InspectSheetDto, RunSyncDto, UpdateSyncDto } from './dto/google-sync.dto';
import { loadGoogleConfig, settingsReturnUrl } from './google-config';
import { GoogleFeatureService } from './google-feature.service';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleSyncService } from './google-sync.service';
import { CONTACT_FIELDS } from './sheet-mapping';

/** Cài đặt > Kết nối > Google Sheets. Quyền: `integrations.webhooks` (nhóm quản trị kết nối) + quyền dữ liệu theo đích. */
@ApiTags('Google Sheets')
@ApiBearerAuth()
@Controller('integrations/google')
export class GoogleController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: GoogleOAuthService,
    private readonly syncs: GoogleSyncService,
    private readonly feature: GoogleFeatureService,
  ) {}

  @Get('status')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Trạng thái kết nối Google (không bao giờ trả token)' })
  async status() {
    const cfg = loadGoogleConfig();
    const conn = await this.oauth.current();
    return {
      feature_enabled: await this.feature.isEnabled(),
      configured: cfg !== null,
      secret_key_configured: isSecretKeyConfigured(),
      redirect_uri: cfg?.redirectUri ?? null,
      connection: conn ? { id: conn.id, email: conn.google_email, status: conn.status, last_error: conn.last_error, connected_at: conn.created_at } : null,
    };
  }

  @Post('oauth/start')
  @HttpCode(200)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Lấy URL đồng ý của Google (FE chuyển hướng người dùng tới đó)' })
  async start(@CurrentUser() user: AuthUser) {
    await this.feature.assertEnabled();
    return { url: this.oauth.authUrl(user.userId) };
  }

  /** Google chuyển trình duyệt về đây (không có JWT) — `state` ký HMAC gắn người bấm + hạn 10 phút. */
  @Get('oauth/callback')
  @Public()
  @ApiOperation({ summary: 'Callback OAuth Google (chuyển hướng về trang Cài đặt)' })
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    const back = settingsReturnUrl();
    if (error || !code || !state) return res.redirect(`${back}${error === 'access_denied' ? 'denied' : 'error'}`);
    try {
      await this.feature.assertEnabled();
      await this.oauth.handleCallback(code, state);
      return res.redirect(`${back}connected`);
    } catch {
      return res.redirect(`${back}error`);
    }
  }

  @Delete('connection')
  @HttpCode(204)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Ngắt kết nối Google: thu hồi token, tạm tắt mọi cấu hình đồng bộ' })
  async disconnect() {
    await this.oauth.disconnect();
  }

  @Post('inspect')
  @HttpCode(200)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Đọc tab + dòng tiêu đề của một Google Sheet' })
  async inspect(@Body() dto: InspectSheetDto) {
    await this.feature.assertEnabled();
    return this.syncs.inspect(dto.spreadsheet, dto.tab);
  }

  @Get('targets')
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Đích đồng bộ: trường khách + các bảng tuỳ biến (và trường của chúng)' })
  async targets() {
    await this.feature.assertEnabled();
    const objects = await this.prisma.customObject.findMany({
      where: { deleted_at: null, is_active: true },
      orderBy: { nav_order: 'asc' },
      take: 100,
      select: { key: true, label_plural: true, fields: { where: { deleted_at: null, NOT: { type: 'formula' } }, orderBy: { sort_order: 'asc' }, select: { key: true, label: true, type: true, required: true } } },
    });
    return { contact_fields: CONTACT_FIELDS, custom_objects: objects };
  }

  @Get('syncs')
  @Can('integrations.webhooks')
  async list() {
    await this.feature.assertEnabled();
    return { data: (await this.syncs.list()).map(present) };
  }

  @Post('syncs')
  @Can('integrations.webhooks')
  async create(@Body() dto: CreateSyncDto, @CurrentUser() user: AuthUser) {
    await this.feature.assertEnabled();
    if (dto.direction === 'import' && dto.actor_user_id && dto.actor_user_id !== user.userId && !user.isAdmin && !can(user.grants, 'contacts.transfer', 'all')) {
      throw new ForbiddenException('Cần quyền chuyển khách phạm vi toàn bộ để chọn người nhận khác');
    }
    return present(await this.syncs.create(dto, user));
  }

  @Patch('syncs/:id')
  @Can('integrations.webhooks')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSyncDto, @CurrentUser() user: AuthUser) {
    await this.feature.assertEnabled();
    return present(await this.syncs.update(id, dto, user));
  }

  @Delete('syncs/:id')
  @HttpCode(204)
  @Can('integrations.webhooks')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    await this.feature.assertEnabled();
    await this.syncs.remove(id, user);
  }

  @Post('syncs/:id/run')
  @HttpCode(200)
  @Can('integrations.webhooks')
  @ApiOperation({ summary: 'Chạy ngay một cấu hình (nhập hoặc xuất)' })
  async run(@Param('id', ParseIntPipe) id: number, @Body() dto: RunSyncDto, @CurrentUser() user: AuthUser) {
    await this.feature.assertEnabled();
    return this.syncs.runAs(id, user, { backfill: dto.backfill });
  }

  @Get('syncs/:id/runs')
  @Can('integrations.webhooks')
  async runs(@Param('id', ParseIntPipe) id: number) {
    await this.feature.assertEnabled();
    return { data: (await this.syncs.runs(id)).map((r) => ({ ...r, id: r.id.toString() })) };
  }
}

/** BigInt không serialize được JSON; không lộ con trỏ nội bộ. */
function present(s: { export_cursor: bigint; [k: string]: unknown }) {
  const { export_cursor: _cursor, ...rest } = s;
  void _cursor;
  return rest;
}
