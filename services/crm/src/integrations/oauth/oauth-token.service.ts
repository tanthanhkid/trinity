import { Injectable, Logger } from '@nestjs/common';
import type { OauthClient } from '@prisma/client';
import { IntegrationAuditService, PrismaService } from '@trinity/prisma';
import { PermissionService } from '@trinity/rbac-nest';
import { can } from '@trinity/rbac';
import { ACCESS_TTL_SEC, OAUTH_SCOPES, REFRESH_TTL_MS, isCanonicalResource, publicBaseUrl, type OauthScope } from './oauth-config';
import { CODE_VERIFIER_RE, pkceS256, randomToken, safeEqual, sha256Hex } from './oauth-crypto';
import { OAuthError } from './oauth-error';
import { OauthClientsService } from './oauth-clients.service';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface VerifiedAccessToken {
  tokenId: bigint;
  userId: number;
  email: string;
  clientId: string;
  scopes: string[];
  familyId: string;
}

const LAST_USED_THROTTLE_MS = 60_000;
const REFRESH_GRACE_MS = 10_000;
const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const invalidGrant = (desc: string): OAuthError => new OAuthError('invalid_grant', desc);

@Injectable()
export class OauthTokenService {
  private readonly logger = new Logger(OauthTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: OauthClientsService,
    private readonly permissions: PermissionService,
    private readonly audit: IntegrationAuditService,
  ) {}

  async token(body: Record<string, unknown>): Promise<TokenResponse> {
    const grant = s(body.grant_type);
    if (grant !== 'authorization_code' && grant !== 'refresh_token') {
      throw new OAuthError('unsupported_grant_type', 'Chỉ hỗ trợ authorization_code và refresh_token');
    }
    const client = await this.clients.authenticate(s(body.client_id) ?? '', s(body.client_secret));
    const out = grant === 'authorization_code' ? await this.exchangeCode(client, body) : await this.refresh(client, body);
    await this.clients.touch(client);
    return out;
  }

  private base(): string {
    const b = publicBaseUrl();
    if (!b) throw new OAuthError('server_error', 'Chưa cấu hình INTEGRATIONS_PUBLIC_BASE_URL', 503);
    return b;
  }

  /** Người dùng còn dùng được (chưa khoá/xoá) VÀ còn quyền nối AI — kiểm MỖI lần đổi code/refresh. */
  private async userStillAllowed(userId: number): Promise<boolean> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true, deleted_at: true } });
    if (!u || u.deleted_at || u.status !== 'active') return false;
    const { grants, isAdmin } = await this.permissions.grantsFor(userId);
    return isAdmin || can(grants, 'integrations.ai_connect');
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.oauthToken.updateMany({ where: { family_id: familyId, revoked_at: null }, data: { revoked_at: new Date() } });
  }

  private async exchangeCode(client: OauthClient, body: Record<string, unknown>): Promise<TokenResponse> {
    const code = s(body.code);
    const verifier = s(body.code_verifier);
    if (!code || !verifier) throw new OAuthError('invalid_request', 'Thiếu code hoặc code_verifier');
    const codeHash = sha256Hex(code);
    // Nhận mã NGUYÊN TỬ (chỉ 1 request thắng) — kể cả khi PKCE sai mã vẫn bị đốt (OAuth 2.1 §4.1.3).
    const claimed = await this.prisma.oauthAuthorizationCode.updateMany({
      where: { code_hash: codeHash, used_at: null, expires_at: { gt: new Date() } },
      data: { used_at: new Date() },
    });
    const row = await this.prisma.oauthAuthorizationCode.findUnique({ where: { code_hash: codeHash } });
    if (claimed.count !== 1 || !row) {
      // Dùng lại mã ⇒ thu hồi mọi token sinh ra từ nó — CHỈ khi đúng client (người lạ biết client_id công khai không được ép thu hồi phiên của nạn nhân).
      if (row?.used_at && row.client_id === client.client_id) await this.revokeFamily(row.family_id);
      throw invalidGrant('Mã uỷ quyền không hợp lệ, đã hết hạn hoặc đã dùng');
    }
    if (row.client_id !== client.client_id) throw invalidGrant('Mã không cấp cho client này');
    const redirectUri = s(body.redirect_uri);
    if (!redirectUri || redirectUri !== row.redirect_uri) throw invalidGrant('redirect_uri không khớp lúc xin mã');
    if (!CODE_VERIFIER_RE.test(verifier) || !safeEqual(pkceS256(verifier), row.code_challenge)) throw invalidGrant('code_verifier sai (PKCE)');
    const resource = s(body.resource);
    if (resource !== undefined && !isCanonicalResource(resource, this.base())) throw new OAuthError('invalid_target', 'resource không hợp lệ');
    if (!(await this.userStillAllowed(row.user_id))) {
      await this.revokeFamily(row.family_id);
      throw invalidGrant('Tài khoản không còn quyền kết nối AI');
    }
    const out = await this.issue({ clientId: client.client_id, userId: row.user_id, scopes: row.scopes, resource: row.resource, familyId: row.family_id });
    await this.audit.log({ channel: 'mcp', action: 'oauth.token_issued', status: 'ok', clientId: client.client_id, userId: row.user_id, metadata: { grant: 'authorization_code', scopes: row.scopes } });
    return out;
  }

  private async refresh(client: OauthClient, body: Record<string, unknown>): Promise<TokenResponse> {
    const raw = s(body.refresh_token);
    if (!raw) throw new OAuthError('invalid_request', 'Thiếu refresh_token');
    const row = await this.prisma.oauthToken.findUnique({ where: { refresh_hash: sha256Hex(raw) } });
    if (!row || row.client_id !== client.client_id) throw invalidGrant('refresh_token không hợp lệ');
    if (row.revoked_at || row.refresh_expires_at.getTime() <= Date.now()) throw invalidGrant('refresh_token đã bị thu hồi hoặc hết hạn');
    // Xoay vòng: nhận NGUYÊN TỬ. Đã dùng rồi (hoặc thua cuộc đua) ⇒ coi là bị đánh cắp/dùng lại ⇒ thu hồi CẢ chuỗi.
    const claimed = await this.prisma.oauthToken.updateMany({
      where: { id: row.id, refresh_used_at: null, revoked_at: null },
      data: { refresh_used_at: new Date() },
    });
    if (claimed.count !== 1 && !(await this.isConcurrentRefresh(row.id))) {
      await this.revokeFamily(row.family_id);
      await this.audit.log({ channel: 'mcp', action: 'oauth.refresh_reuse', status: 'denied', clientId: client.client_id, userId: row.user_id, metadata: { family_revoked: true } });
      throw invalidGrant('refresh_token đã được dùng — toàn bộ phiên kết nối đã bị thu hồi để an toàn');
    }
    if (!(await this.userStillAllowed(row.user_id))) {
      await this.revokeFamily(row.family_id);
      throw invalidGrant('Tài khoản không còn quyền kết nối AI');
    }
    // `offline_access` được quảng bá + chấp nhận ở authorize/DCR nhưng không phải scope cấp quyền (refresh token luôn có):
    // client gửi lại nguyên scope đã xin thì bỏ nó đi, tránh invalid_scope oan. Chỉ còn mỗi nó ⇒ coi như không hỏi.
    const askedRaw = s(body.scope)?.split(/\s+/).filter(Boolean).filter((x) => x !== 'offline_access');
    const asked = askedRaw && askedRaw.length > 0 ? askedRaw : undefined;
    const scopes = asked ? asked.filter((x): x is OauthScope => (OAUTH_SCOPES as readonly string[]).includes(x)) : row.scopes;
    if (asked && (scopes.length !== asked.length || scopes.some((x) => !row.scopes.includes(x)))) {
      throw new OAuthError('invalid_scope', 'scope vượt quá phạm vi đã được cấp');
    }
    const resource = s(body.resource);
    if (resource !== undefined && !isCanonicalResource(resource, this.base())) throw new OAuthError('invalid_target', 'resource không hợp lệ');
    const out = await this.issue({ clientId: row.client_id, userId: row.user_id, scopes, resource: row.resource, familyId: row.family_id });
    await this.audit.log({ channel: 'mcp', action: 'oauth.token_refreshed', status: 'ok', clientId: client.client_id, userId: row.user_id, metadata: { scopes } });
    return out;
  }

  /**
   * Client gọi song song nhiều request cùng lúc hết hạn ⇒ nhiều lần refresh với CÙNG token trong vài giây. Trong cửa sổ ngắn
   * sau lần xoay đầu, coi là trùng lặp lành tính (cấp cặp mới cùng chuỗi, không thu hồi). Quá cửa sổ ⇒ dùng lại = bị đánh cắp.
   */
  private async isConcurrentRefresh(id: bigint): Promise<boolean> {
    const cur = await this.prisma.oauthToken.findUnique({ where: { id }, select: { refresh_used_at: true, revoked_at: true } });
    return !!cur && !cur.revoked_at && !!cur.refresh_used_at && Date.now() - cur.refresh_used_at.getTime() < REFRESH_GRACE_MS;
  }

  private async issue(p: { clientId: string; userId: number; scopes: string[]; resource: string; familyId: string }): Promise<TokenResponse> {
    const access = `trn_at_${randomToken(32)}`;
    const refresh = `trn_rt_${randomToken(32)}`;
    const now = Date.now();
    const created = await this.prisma.oauthToken.create({
      data: {
        access_hash: sha256Hex(access),
        refresh_hash: sha256Hex(refresh),
        client_id: p.clientId,
        user_id: p.userId,
        scopes: p.scopes,
        resource: p.resource,
        family_id: p.familyId,
        access_expires_at: new Date(now + ACCESS_TTL_SEC * 1000),
        refresh_expires_at: new Date(now + REFRESH_TTL_MS),
      },
      select: { id: true },
    });
    // Người dùng có thể bấm "Thu hồi" đúng lúc ta đang cấp ⇒ chuỗi đã có dòng bị thu hồi: huỷ luôn dòng vừa tạo (không để kết nối sống lại).
    const dead = await this.prisma.oauthToken.findFirst({ where: { family_id: p.familyId, revoked_at: { not: null }, id: { not: created.id } }, select: { id: true } });
    if (dead) {
      await this.revokeFamily(p.familyId);
      throw invalidGrant('Kết nối đã bị thu hồi');
    }
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: p.scopes.join(' ') };
  }

  /** RFC 7009 — luôn thành công (không lộ token có tồn tại không). Thu hồi CẢ chuỗi của token đó. */
  async revoke(body: Record<string, unknown>): Promise<void> {
    const raw = s(body.token);
    const client = await this.clients.authenticate(s(body.client_id) ?? '', s(body.client_secret));
    if (!raw) return;
    const h = sha256Hex(raw);
    const row = await this.prisma.oauthToken.findFirst({ where: { OR: [{ access_hash: h }, { refresh_hash: h }] }, select: { family_id: true, client_id: true, user_id: true } });
    if (!row || row.client_id !== client.client_id) return;
    await this.revokeFamily(row.family_id);
    await this.audit.log({ channel: 'mcp', action: 'oauth.revoke', status: 'ok', clientId: client.client_id, userId: row.user_id, metadata: { by: 'client' } });
  }

  /**
   * Xác minh access token cho MCP: băm → tra → chưa thu hồi, chưa hết hạn, ĐÚNG audience (`resource`).
   * Việc "user bị khoá/mất quyền" do caller kiểm (cần `PermissionService`) — nhưng hàm này cũng chặn user khoá/xoá để không sót.
   */
  async verifyAccessToken(raw: string): Promise<VerifiedAccessToken | null> {
    if (!raw || raw.length > 256) return null;
    const row = await this.prisma.oauthToken.findUnique({ where: { access_hash: sha256Hex(raw) } });
    if (!row || row.revoked_at || row.access_expires_at.getTime() <= Date.now()) return null;
    const base = publicBaseUrl();
    if (!base || !isCanonicalResource(row.resource, base)) return null;
    const u = await this.prisma.user.findUnique({ where: { id: row.user_id }, select: { status: true, deleted_at: true, email: true } });
    if (!u || u.deleted_at || u.status !== 'active') return null;
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > LAST_USED_THROTTLE_MS) {
      this.prisma.oauthToken.update({ where: { id: row.id }, data: { last_used_at: new Date() }, select: { id: true } }).catch((e: unknown) => {
        this.logger.warn(`oauth last_used update failed: ${(e as Error)?.message}`);
      });
    }
    return { tokenId: row.id, userId: row.user_id, email: u.email, clientId: row.client_id, scopes: row.scopes, familyId: row.family_id };
  }

  /** Thu hồi theo chuỗi (dùng cho màn "Kết nối AI"). */
  revokeFamilyById(familyId: string): Promise<void> {
    return this.revokeFamily(familyId);
  }
}
