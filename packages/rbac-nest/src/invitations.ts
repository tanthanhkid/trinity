import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import { assertEmailAvailableForCurrentCompany, currentCompanyId, isMultiTenant, type PrismaService } from '@trinity/prisma';
import { isSubset, mergeGrants, normalizeGrant, type Grants, type Permission } from '@trinity/rbac';
import type { AuthUser } from './auth-user';
import { assertUserSlotAvailable } from './plan-limits';
import type { ScopeService } from './scope.service';
import { scopeWhere } from './scope-where';
import { withCompanyPrefix } from './company-token';

/**
 * Lời mời nhân viên bằng link (chưa có dịch vụ gửi mail): chủ công ty tạo link, tự gửi qua Zalo/Messenger.
 *  - token = `cN.` + 32 byte ngẫu nhiên (công ty 1 không có tiền tố, như khoá API); DB chỉ giữ SHA-256 của token;
 *  - hết hạn sau 7 ngày, dùng một lần, huỷ được;
 *  - mỗi lời mời còn hiệu lực giữ một chỗ trong `maxUsers` của gói.
 * Dùng chung cho màn web (services/auth) và tool MCP (services/crm) — cùng một luật.
 */
export const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export function hashInviteToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function newInviteToken(companyId: number): string {
  return withCompanyPrefix(randomBytes(32).toString('base64url'), companyId);
}

/** Đường dẫn trang nhận lời mời trên web (ghép với địa chỉ gốc của trang web để thành link). */
export function invitePath(token: string): string {
  return `/invite/${token}`;
}

export function invitationStatus(row: { accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }, now = new Date()): InvitationStatus {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  return row.expires_at.getTime() <= now.getTime() ? 'expired' : 'pending';
}

function grantsOfRoles(roles: { grants: { permission: string; scope: string | null }[] }[]): Grants {
  return mergeGrants(
    roles.map((r) => {
      const g: Grants = {};
      for (const rp of r.grants) {
        const v = normalizeGrant(rp.permission, rp.scope);
        if (v !== null) g[rp.permission as Permission] = v;
      }
      return g;
    }),
  );
}

/** Cùng luật chống leo thang quyền như gán vai trò: không mời được vào vai trò to hơn mình. */
async function assertCanInviteToRole(db: PrismaService, actor: AuthUser, roleId: number) {
  const role = await db.role.findUnique({
    where: { id: roleId },
    select: { id: true, name: true, is_system: true, grants: { select: { permission: true, scope: true } } },
  });
  if (!role) throw new NotFoundException('Không tìm thấy vai trò');
  if (!actor.isAdmin) {
    if (role.is_system) throw new ForbiddenException('Chỉ Quản trị mới được mời vào vai trò Quản trị');
    if (!isSubset(grantsOfRoles([role]), actor.grants)) throw new ForbiddenException('Không thể cấp quyền bạn không có');
  }
  return role;
}

export interface InvitationView {
  id: number;
  email: string;
  role_id: number | null;
  role_name: string | null;
  status: InvitationStatus;
  expires_at: Date;
  created_at: Date;
}

export interface CreatedInvitation extends InvitationView {
  /** Token gốc — chỉ có ở lần tạo, DB không giữ. */
  token: string;
  path: string;
}

export async function createInvitation(
  db: PrismaService,
  actor: AuthUser,
  input: { email: string; roleId: number },
): Promise<CreatedInvitation> {
  const email = input.email.trim().toLowerCase();
  const role = await assertCanInviteToRole(db, actor, input.roleId);
  // Email đã thuộc công ty khác (platform.company_logins) → báo rõ ngay, đừng đợi tới lúc người ta mở link.
  await assertEmailAvailableForCurrentCompany(email);
  const already = await db.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deleted_at: null },
    select: { id: true },
  });
  if (already) throw new ConflictException('Email này đã có tài khoản trong công ty của bạn');

  const token = newInviteToken(isMultiTenant() ? (currentCompanyId() ?? 1) : 1);
  const now = new Date();
  const row = await db.$transaction(async (tx) => {
    // Mời lại cùng email = thay lời mời cũ (link cũ chết), không giữ hai chỗ.
    await tx.userInvitation.updateMany({
      where: { email, accepted_at: null, revoked_at: null },
      data: { revoked_at: now },
    });
    // Đếm người active + lời mời đang chờ dưới khoá advisory của công ty (cùng luật với mọi đường thêm người).
    await assertUserSlotAvailable(tx);
    return tx.userInvitation.create({
      data: {
        email,
        role_id: role.id,
        token_hash: hashInviteToken(token),
        expires_at: new Date(now.getTime() + INVITE_TTL_MS),
        created_by: actor.userId,
      },
    });
  });
  return {
    id: row.id,
    email: row.email,
    role_id: role.id,
    role_name: role.name,
    status: 'pending',
    expires_at: row.expires_at,
    created_at: row.created_at,
    token,
    path: invitePath(token),
  };
}

/**
 * Phạm vi lời mời của người dùng theo `users.manage`: `'all'` thấy/huỷ mọi lời mời của công ty; phạm vi hẹp
 * (own/team/subtree) chỉ lời mời do người trong phạm vi đó tạo.
 */
export async function invitationScope(scope: ScopeService, actor: AuthUser): Promise<number[] | 'all'> {
  return (await scope.ownerIds(actor, 'users.manage')) ?? [];
}

/** Lời mời gần đây (mới nhất trước). `pendingOnly` = chỉ cái còn hiệu lực; `owners` = phạm vi theo người tạo. */
export async function listInvitations(
  db: PrismaService,
  opts: { pendingOnly?: boolean; limit?: number; owners?: number[] | 'all' } = {},
): Promise<InvitationView[]> {
  const now = new Date();
  const rows = await db.userInvitation.findMany({
    where: {
      AND: [
        opts.pendingOnly ? { accepted_at: null, revoked_at: null, expires_at: { gt: now } } : {},
        scopeWhere(opts.owners ?? 'all', ['created_by']),
      ],
    },
    orderBy: { id: 'desc' },
    take: Math.min(Math.max(opts.limit ?? 100, 1), 200),
  });
  const roleIds = [...new Set(rows.map((r) => r.role_id).filter((x): x is number => x !== null))];
  const roles = roleIds.length ? await db.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(roles.map((r) => [r.id, r.name]));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role_id: r.role_id,
    role_name: r.role_id !== null ? (names.get(r.role_id) ?? null) : null,
    status: invitationStatus(r, now),
    expires_at: r.expires_at,
    created_at: r.created_at,
  }));
}

/** Huỷ lời mời còn hiệu lực (link chết ngay). Đã dùng/đã huỷ/hết hạn thì báo rõ. */
export async function revokeInvitation(db: PrismaService, id: number, owners: number[] | 'all' = 'all'): Promise<void> {
  const row = await db.userInvitation.findUnique({ where: { id } });
  // Ngoài phạm vi users.manage của người huỷ → 404 như chưa từng có.
  if (!row || (owners !== 'all' && (row.created_by === null || !owners.includes(row.created_by)))) {
    throw new NotFoundException('Không tìm thấy lời mời');
  }
  if (invitationStatus(row) !== 'pending') throw new ConflictException('Lời mời này không còn hiệu lực để huỷ');
  await db.userInvitation.updateMany({ where: { id, accepted_at: null, revoked_at: null }, data: { revoked_at: new Date() } });
}

export const INVITATION_GONE_MESSAGE = 'Lời mời không còn hiệu lực (đã dùng, đã bị huỷ hoặc hết hạn). Hãy nhờ chủ công ty gửi link mới.';

/** Tìm lời mời còn hiệu lực theo token gốc; không có/không còn hiệu lực → 410. */
export async function findPendingInvitation(db: PrismaService, rawToken: string) {
  const row = await db.userInvitation.findUnique({ where: { token_hash: hashInviteToken(rawToken) } });
  if (!row || invitationStatus(row) !== 'pending') throw new GoneException(INVITATION_GONE_MESSAGE);
  return row;
}
