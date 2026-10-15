import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { can } from '@trinity/rbac';
import { PermissionService, type AuthUser } from '@trinity/rbac-nest';
import { OauthTokenService } from '../oauth/oauth-token.service';

export type McpAuthFailure = 'missing' | 'invalid_token' | 'insufficient_scope';

export class McpAuthError extends Error {
  constructor(
    readonly kind: McpAuthFailure,
    readonly description: string,
    /** Có khi token đã nhận diện được người dùng/client (để ghi nhật ký `denied`). */
    readonly who?: { userId: number; clientId: string },
  ) {
    super(`${kind}: ${description}`);
  }
}

export interface McpPrincipal {
  userId: number;
  email: string;
  clientId: string;
  scopes: string[];
  tokenId: bigint;
  /** Người dùng ĐÃ GIỚI HẠN cho AI: không có `*.phone_full`, `isAdmin=false` — dùng để gọi mọi service nghiệp vụ. */
  user: AuthUser;
}

/**
 * Cho AI chỉ thấy tối đa những gì người dùng thấy, và SĐT luôn che: gỡ MỌI quyền `*.phone_full` khỏi grants
 * (service nghiệp vụ che qua `ScopeService.ownerIds(user,'…phone_full')` ⇒ `null` ⇒ che hết) và bỏ cờ admin
 * (admin có mọi quyền ở `grants` nên vẫn đủ phạm vi `all`, nhưng không có đường tắt `isAdmin`).
 */
export function restrictForAi(user: AuthUser): AuthUser {
  const grants = { ...user.grants };
  for (const key of Object.keys(grants)) if (key.endsWith('.phone_full')) delete (grants as Record<string, unknown>)[key];
  return { ...user, isAdmin: false, grants };
}

@Injectable()
export class McpAuthService {
  constructor(
    private readonly tokens: OauthTokenService,
    private readonly permissions: PermissionService,
  ) {}

  /** Danh tính CHỈ từ token OAuth đã kiểm (băm → tra DB → chưa thu hồi/hết hạn, đúng audience, user còn hoạt động). */
  async authenticate(req: Request): Promise<McpPrincipal> {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m) throw new McpAuthError('missing', 'Thiếu Bearer token');
    const verified = await this.tokens.verifyAccessToken(m[1]);
    if (!verified) throw new McpAuthError('invalid_token', 'Token không hợp lệ, đã hết hạn hoặc đã bị thu hồi');
    const { grants, isAdmin } = await this.permissions.grantsFor(verified.userId);
    if (!isAdmin && !can(grants, 'integrations.ai_connect')) {
      throw new McpAuthError('invalid_token', 'Tài khoản không còn quyền kết nối AI', { userId: verified.userId, clientId: verified.clientId });
    }
    if (!verified.scopes.includes('crm.read')) throw new McpAuthError('insufficient_scope', 'Token thiếu scope crm.read', { userId: verified.userId, clientId: verified.clientId });
    const user = restrictForAi({ userId: verified.userId, email: verified.email, isAdmin, grants });
    return { userId: verified.userId, email: verified.email, clientId: verified.clientId, scopes: verified.scopes, tokenId: verified.tokenId, user };
  }
}
