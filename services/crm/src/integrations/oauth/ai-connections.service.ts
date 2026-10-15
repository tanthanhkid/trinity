import { Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationAuditService, PrismaService } from '@trinity/prisma';
import { OauthTokenService } from './oauth-token.service';

export interface AiConnectionRow {
  id: string;
  client_id: string;
  client_name: string;
  client_kind: string;
  user: { id: number; full_name: string | null; email: string };
  scopes: string[];
  connected_at: Date | null;
  last_used_at: Date | null;
  refresh_expires_at: Date;
}

const FAMILY_RE = /^[0-9a-f-]{36}$/i;
const MAX_ROWS = 200;

/** Danh sách "ứng dụng đã cấp quyền" = mỗi chuỗi token (`family_id`) còn hiệu lực là 1 kết nối. */
@Injectable()
export class AiConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: OauthTokenService,
    private readonly audit: IntegrationAuditService,
  ) {}

  async list(userId: number, all: boolean): Promise<AiConnectionRow[]> {
    const heads = await this.prisma.oauthToken.findMany({
      where: { revoked_at: null, refresh_used_at: null, refresh_expires_at: { gt: new Date() }, ...(all ? {} : { user_id: userId }) },
      orderBy: { id: 'desc' },
      take: MAX_ROWS,
      select: { family_id: true, client_id: true, user_id: true, scopes: true, last_used_at: true, refresh_expires_at: true },
    });
    if (heads.length === 0) return [];
    const families = heads.map((h) => h.family_id);
    const [firsts, clients, users] = await Promise.all([
      this.prisma.oauthToken.groupBy({ by: ['family_id'], where: { family_id: { in: families } }, _min: { created_at: true } }),
      this.prisma.oauthClient.findMany({ where: { client_id: { in: heads.map((h) => h.client_id) } }, select: { client_id: true, name: true, kind: true } }),
      this.prisma.user.findMany({ where: { id: { in: heads.map((h) => h.user_id) } }, select: { id: true, full_name: true, email: true } }),
    ]);
    const first = new Map(firsts.map((f) => [f.family_id, f._min.created_at]));
    const cl = new Map(clients.map((c) => [c.client_id, c]));
    const us = new Map(users.map((u) => [u.id, u]));
    return heads.map((h) => ({
      id: h.family_id,
      client_id: h.client_id,
      client_name: cl.get(h.client_id)?.name ?? 'Ứng dụng đã xoá',
      client_kind: cl.get(h.client_id)?.kind ?? 'dcr',
      user: us.get(h.user_id) ?? { id: h.user_id, full_name: null, email: '' },
      scopes: h.scopes,
      connected_at: first.get(h.family_id) ?? null,
      last_used_at: h.last_used_at,
      refresh_expires_at: h.refresh_expires_at,
    }));
  }

  /** Thu hồi cả chuỗi. Của người khác mà không có `ai_admin` ⇒ 404 (không lộ tồn tại). */
  async revoke(familyId: string, actorId: number, isAdmin: boolean): Promise<void> {
    if (!FAMILY_RE.test(familyId)) throw new NotFoundException('Không tìm thấy kết nối');
    const row = await this.prisma.oauthToken.findFirst({
      where: { family_id: familyId, revoked_at: null, ...(isAdmin ? {} : { user_id: actorId }) },
      select: { user_id: true, client_id: true },
    });
    if (!row) throw new NotFoundException('Không tìm thấy kết nối');
    await this.tokens.revokeFamilyById(familyId);
    await this.audit.log({ channel: 'mcp', action: 'oauth.revoke', status: 'ok', clientId: row.client_id, userId: actorId, metadata: { by: row.user_id === actorId ? 'owner' : 'admin', target_user_id: row.user_id } });
  }
}
