import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { FacebookPage } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { decryptSecret, encryptSecret, IntegrationsKeyError, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { SUBSCRIBED_FIELDS, commentAutomationEnabled, facebookScopes, isFacebookConfigured, subscribedFields, loadFacebookConfig, oauthRedirectUri } from './facebook.config';
import { signFacebookState, verifyFacebookState } from './facebook-oauth-state';
import { GraphApiError, GraphClient, type TokenDebug } from './graph-client';

/** Phản hồi — KHÔNG có `token_enc`. */
export function toPageView(p: FacebookPage) {
  const { token_enc: _t, ...rest } = p;
  return rest;
}

export interface UpdatePageInput {
  default_assignee_id?: number;
  contact_source_id?: number;
  is_active?: boolean;
}

/** `debug_token` → trạng thái lưu. `expires_at` = 0/thiếu: không hết hạn (page token dài hạn). */
export function tokenStateFromDebug(d: TokenDebug, now = Date.now()): { status: 'active' | 'expired' | 'invalid'; expiresAt: Date | null; dataAccessExpiresAt: Date | null } {
  const toDate = (s?: number) => (s ? new Date(s * 1000) : null);
  const expiresAt = toDate(d.expires_at);
  const dataAccessExpiresAt = toDate(d.data_access_expires_at);
  if (!d.is_valid) return { status: 'invalid', expiresAt, dataAccessExpiresAt };
  const gone = (expiresAt && expiresAt.getTime() <= now) || (dataAccessExpiresAt && dataAccessExpiresAt.getTime() <= now);
  return { status: gone ? 'expired' : 'active', expiresAt, dataAccessExpiresAt };
}

/** Kết nối Fanpage: đăng nhập Facebook → lấy page token (mã hoá) → đăng ký webhook → kiểm hạn. */
@Injectable()
export class FacebookPagesService {
  private readonly logger = new Logger(FacebookPagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphClient,
    private readonly scope: ScopeService,
  ) {}

  private key(): Buffer {
    try {
      return loadSecretKey();
    } catch (err) {
      if (err instanceof IntegrationsKeyError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  status() {
    const c = loadFacebookConfig();
    return {
      configured: isFacebookConfigured(c),
      app_id_set: Boolean(c.appId),
      app_secret_set: Boolean(c.appSecret),
      base_url_set: Boolean(c.baseUrl),
      verify_token_set: Boolean(c.verifyToken),
      secret_key_configured: (() => { try { loadSecretKey(); return true; } catch { return false; } })(),
      graph_version: c.graphVersion,
      webhook_url: c.baseUrl ? `${c.baseUrl}/api/v1/facebook/webhook` : null,
      oauth_redirect_uri: c.baseUrl ? oauthRedirectUri(c) : null,
      scopes: facebookScopes(),
      comment_automation: commentAutomationEnabled(),
    };
  }

  connectUrl(actor: AuthUser): { url: string } {
    const c = loadFacebookConfig();
    if (!isFacebookConfigured(c)) throw new ServiceUnavailableException('Chưa cấu hình FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / INTEGRATIONS_PUBLIC_BASE_URL trên máy chủ.');
    this.key();
    const q = new URLSearchParams({
      client_id: c.appId,
      redirect_uri: oauthRedirectUri(c),
      state: signFacebookState(actor.userId),
      scope: facebookScopes().join(','),
      response_type: 'code',
    });
    return { url: `https://www.facebook.com/${c.graphVersion}/dialog/oauth?${q.toString()}` };
  }

  /** Nguồn khách mặc định cho Page mới: option `contact_source` đang bật, ưu tiên nhãn chứa "facebook". */
  private async defaultSourceId(): Promise<number> {
    const opts = await this.prisma.settingOption.findMany({ where: { group_key: 'contact_source', is_active: true }, orderBy: { id: 'asc' }, select: { id: true, label: true } });
    const pick = opts.find((o) => /facebook|fb/i.test(o.label)) ?? opts[0];
    if (!pick) throw new BadRequestException('Chưa có nguồn khách (Cài đặt > Danh mục > Nguồn khách) — tạo một nguồn rồi kết nối lại.');
    return pick.id;
  }

  /** Xử lý callback đăng nhập: trả số Page đã kết nối. State sai/hết hạn ⇒ 400. */
  async handleCallback(code: string, state: string): Promise<{ connected: number; failed: number }> {
    const st = verifyFacebookState(state);
    if (!st) throw new BadRequestException('Phiên kết nối Facebook không hợp lệ hoặc đã hết hạn. Hãy bấm "Kết nối" lại.');
    const c = loadFacebookConfig();
    if (!isFacebookConfigured(c)) throw new ServiceUnavailableException('Chưa cấu hình Facebook App trên máy chủ.');
    const key = this.key();
    const sourceId = await this.defaultSourceId();
    const user = await this.graph.toLongLived(await this.graph.exchangeCode(code, oauthRedirectUri(c)));
    const pages = await this.graph.listPages(user);
    let failed = 0;
    for (const p of pages) {
      try {
        await this.saveConnectedPage(p, st.userId, sourceId, key);
      } catch (err) {
        failed++;
        this.logger.warn(`Kết nối Page ${p.id} lỗi: ${(err as Error).message}`);
      }
    }
    return { connected: pages.length - failed, failed };
  }

  private async saveConnectedPage(p: { id: string; name: string; access_token: string }, userId: number, sourceId: number, key: Buffer): Promise<void> {
    const subscribed = await this.subscribe(p.id, p.access_token);
    const state = await this.graph.debugToken(p.access_token).then((d) => tokenStateFromDebug(d), () => null);
    const common = {
      name: p.name.slice(0, 200),
      token_enc: encryptSecret(p.access_token, key),
      subscribed,
      token_status: state?.status ?? 'unknown',
      token_checked_at: new Date(),
      token_expires_at: state?.expiresAt ?? null,
      data_access_expires_at: state?.dataAccessExpiresAt ?? null,
      is_active: true,
    };
    await this.prisma.facebookPage.upsert({
      where: { page_id: p.id },
      update: common,
      create: { page_id: p.id, ...common, default_assignee_id: userId, contact_source_id: sourceId, connected_by: userId },
    });
  }

  async list() {
    const rows = await this.prisma.facebookPage.findMany({ orderBy: { id: 'asc' } });
    return rows.map(toPageView);
  }

  private async find(id: number): Promise<FacebookPage> {
    const p = await this.prisma.facebookPage.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Không tìm thấy Fanpage');
    return p;
  }

  /** Người nhận phải đang hoạt động VÀ nằm trong phạm vi `contacts.transfer` của người cấu hình (như webhook vào). */
  private async assertAssignable(actor: AuthUser, assigneeId: number): Promise<void> {
    const u = await this.prisma.user.findUnique({ where: { id: assigneeId }, select: { status: true, deleted_at: true } });
    if (!u || u.status !== 'active' || u.deleted_at !== null) throw new BadRequestException('Người nhận không tồn tại hoặc không còn hoạt động');
    if (assigneeId === actor.userId) return;
    const owners = await this.scope.ownerIds(actor, 'contacts.transfer');
    if (owners === 'all' || (owners !== null && owners.includes(assigneeId))) return;
    throw new ForbiddenException('Không có quyền gán khách cho người này (cần contacts.transfer phủ người nhận)');
  }

  async update(id: number, input: UpdatePageInput, actor: AuthUser) {
    await this.find(id);
    if (input.default_assignee_id !== undefined) await this.assertAssignable(actor, input.default_assignee_id);
    if (input.contact_source_id !== undefined) {
      const o = await this.prisma.settingOption.findUnique({ where: { id: input.contact_source_id }, select: { group_key: true, is_active: true } });
      if (!o || o.group_key !== 'contact_source' || !o.is_active) throw new BadRequestException('Nguồn khách không hợp lệ hoặc đang tắt');
    }
    return toPageView(await this.prisma.facebookPage.update({ where: { id }, data: input }));
  }

  /** Ngắt kết nối: huỷ đăng ký webhook (best-effort) rồi xoá token. Hội thoại/tin cũ được giữ. */
  async disconnect(id: number): Promise<void> {
    const p = await this.find(id);
    try {
      await this.graph.unsubscribePage(p.page_id, decryptSecret(p.token_enc, this.key()));
    } catch (err) {
      this.logger.warn(`Huỷ đăng ký webhook Page ${p.page_id}: ${(err as Error).message}`);
    }
    await this.prisma.facebookPage.delete({ where: { id } });
  }

  /**
   * Đăng ký Page nhận webhook. Có thêm `feed` (bình luận) mà Facebook từ chối (app/token chưa có quyền) ⇒ đăng ký lại bộ cũ,
   * vì Facebook từ chối CẢ lệnh khi có một trường không hợp lệ và Page sẽ mất luôn tin nhắn.
   */
  private async subscribe(pageId: string, token: string): Promise<boolean> {
    const ok = await this.subscribeFields(pageId, token);
    if (ok) {
      // Nút "Bắt đầu": cần để khách mới mở link/QR mở chat mang mã nguồn về. Lỗi chỉ ghi log, không làm hỏng kết nối.
      await this.graph.ensureGetStarted(token).catch((err: Error) => this.logger.warn(`Page ${pageId}: không bật được nút "Bắt đầu": ${err.message}`));
    }
    return ok;
  }

  private async subscribeFields(pageId: string, token: string): Promise<boolean> {
    const fields = subscribedFields();
    try {
      await this.graph.subscribePage(pageId, token, fields);
      return true;
    } catch (err) {
      this.logger.warn(`Đăng ký webhook Page ${pageId} (${fields.join(',')}) lỗi (cần pages_manage_metadata): ${(err as Error).message}`);
    }
    if (fields.length === SUBSCRIBED_FIELDS.length) return false;
    try {
      await this.graph.subscribePage(pageId, token, SUBSCRIBED_FIELDS);
      this.logger.warn(`Page ${pageId}: chỉ nhận tin nhắn, chưa nhận bình luận (app/token chưa có quyền đọc bình luận)`);
      return true;
    } catch (err) {
      this.logger.warn(`Đăng ký webhook Page ${pageId} lỗi: ${(err as Error).message}`);
      return false;
    }
  }

  /** Kiểm hạn/hiệu lực token ngay (nút "Kiểm tra"); token còn sống thì đăng ký lại webhook với đủ trường hiện hành. */
  async checkToken(id: number) {
    const p = await this.find(id);
    let data: Partial<FacebookPage>;
    try {
      const token = decryptSecret(p.token_enc, this.key());
      const s = tokenStateFromDebug(await this.graph.debugToken(token));
      data = { token_status: s.status, token_expires_at: s.expiresAt, data_access_expires_at: s.dataAccessExpiresAt };
      // Đăng ký lại mỗi lần kiểm: bản mới thêm trường (`feed` khi bật bình luận, `messaging_referrals` cho link mở chat) thì Page
      // đã kết nối từ trước cũng nhận được. Lệnh idempotent; lỗi chỉ ghi log, giữ trạng thái cũ.
      if (s.status === 'active') {
        if (await this.subscribe(p.page_id, token)) data.subscribed = true;
      }
    } catch (err) {
      if (err instanceof IntegrationsKeyError || err instanceof ServiceUnavailableException) throw err;
      if (err instanceof GraphApiError && err.isTokenError) data = { token_status: 'invalid' };
      else throw new ServiceUnavailableException('Không kiểm tra được token với Facebook, thử lại sau.');
    }
    return toPageView(await this.prisma.facebookPage.update({ where: { id }, data: { ...data, token_checked_at: new Date() } }));
  }

  /** Page + token giải mã cho nội bộ (gửi tin, lấy lead). Page tắt/không có ⇒ null. */
  async activePageWithToken(pageId: string): Promise<{ page: FacebookPage; token: string } | null> {
    const page = await this.prisma.facebookPage.findUnique({ where: { page_id: pageId } });
    if (!page || !page.is_active) return null;
    return { page, token: decryptSecret(page.token_enc, this.key()) };
  }

  /** Graph trả lỗi token (190) ⇒ đánh dấu Page để UI báo "cần kết nối lại". */
  async markTokenInvalid(pageId: string): Promise<void> {
    await this.prisma.facebookPage.updateMany({ where: { page_id: pageId }, data: { token_status: 'invalid', token_checked_at: new Date() } });
  }
}
