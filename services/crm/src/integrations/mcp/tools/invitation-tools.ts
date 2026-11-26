import { ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import { createInvitation, invitableRoles, invitationScope, listInvitations, revokeInvitation, INVITE_TTL_DAYS } from '@trinity/rbac-nest';
import { wrapData } from '../ai-output';
import { ToolUserError, type ToolDef } from './tool-types';

const iso = (d: Date): string => d.toISOString();

/** Lời mời nhân viên đang chờ + các vai trò có thể mời vào. Không trả token/link (chỉ có lúc tạo). */
export const listInvitationsTool: ToolDef = {
  name: 'list_invitations',
  title: 'Lời mời nhân viên / List staff invitations',
  description:
    'Liệt kê lời mời nhân viên bằng link: email, vai trò, trạng thái (pending = còn hiệu lực, accepted = đã vào, revoked = đã huỷ, expired = hết hạn), hạn dùng; kèm roles = các vai trò có thể mời vào (id + tên). ' +
    'Mặc định chỉ lời mời còn hiệu lực; all = true để xem cả cái đã dùng/huỷ/hết hạn. Link không xem lại được (chỉ hiện lúc tạo) — cần link mới thì create_invitation lại cho cùng email; huỷ một lời mời thì cancel_invitation. Chỉ đọc. ' +
    '/ Lists staff invitations (links are shown only once, at creation) plus the roles one can invite to. Read-only.',
  permissions: ['users.manage'],
  input: (z) => ({ all: z.boolean().optional().describe('true = cả lời mời đã dùng/huỷ/hết hạn / Include non-pending ones') }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    // Theo phạm vi users.manage của người dùng: 'all' thấy hết, phạm vi hẹp chỉ lời mời của người trong phạm vi.
    const owners = await invitationScope(deps.scope, principal.user);
    const rows = await listInvitations(deps.prisma, { pendingOnly: args.all !== true, owners });
    const roles = await invitableRoles(deps.prisma, principal.user);
    const out = wrapData({
      invitations: rows.map((r) => ({ id: r.id, email: r.email, role: r.role_name, status: r.status, expires_at: iso(r.expires_at), created_at: iso(r.created_at) })),
      roles: roles.map((r) => ({ id: r.id, name: r.name, system: r.is_system })),
    });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** Tạo link mời nhân viên vào đúng công ty của người dùng. Không gửi mail; người dùng tự gửi link qua Zalo/Messenger. */
export const createInvitationTool: ToolDef = {
  name: 'create_invitation',
  title: 'Mời nhân viên bằng link / Invite a staff member by link',
  description:
    'Tạo link mời một nhân viên vào công ty này (Trinity không gửi email): trả invite_link — đưa nguyên link cho người dùng để họ tự gửi qua Zalo/Messenger. ' +
    `Link hết hạn sau ${INVITE_TTL_DAYS} ngày, dùng một lần; người được mời mở link, nhập tên + mật khẩu là có tài khoản với vai trò đã chọn. ` +
    'Cần email và vai trò (role_id hoặc role_name, xem list_invitations → roles). Mời lại cùng email thì link cũ chết. ' +
    'Báo lỗi rõ khi: vượt số người của gói, email đã dùng ở công ty khác hoặc đã có tài khoản, vai trò to hơn quyền người dùng (vai trò Quản trị không mời qua AI được). ' +
    'Chỉ tạo khi CHÍNH người dùng yêu cầu mời người đó. Huỷ lời mời: cancel_invitation (không xoá được gì; người dùng tự đặt lại mật khẩu nhân viên trên màn Người dùng — AI không đụng mật khẩu). ' +
    '/ Creates a one-time invitation link (7 days) for a new staff member; no email is sent — hand the link to the user.',
  permissions: ['users.manage'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    email: z.string().email().max(255).describe('Email người được mời / Invitee email'),
    role_id: z.number().int().min(1).max(2_147_483_647).optional().describe('Id vai trò / Role id'),
    role_name: z.string().max(100).optional().describe('Tên vai trò (nếu không có role_id) / Role name'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal, baseUrl }) {
    // Không có địa chỉ gốc công khai thì không thể dựng link dùng được — báo trước khi tạo, đừng để lại lời mời mồ côi.
    const origin = (baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(origin)) {
      throw new ToolUserError('Máy chủ chưa cấu hình địa chỉ công khai (INTEGRATIONS_PUBLIC_BASE_URL) nên chưa dựng được link mời; chưa tạo lời mời nào. Hãy báo quản trị máy chủ, hoặc mời bằng nút "Mời bằng link" trên màn Người dùng. / Public base URL is not configured; no invitation was created.');
    }
    let roleId = typeof args.role_id === 'number' ? args.role_id : undefined;
    if (roleId === undefined && typeof args.role_name === 'string' && args.role_name.trim()) {
      const r = await deps.prisma.role.findFirst({ where: { name: { equals: args.role_name.trim(), mode: 'insensitive' } }, select: { id: true } });
      if (!r) throw new ToolUserError(`Không có vai trò tên “${args.role_name.trim()}”. Xem list_invitations → roles. / Unknown role name.`);
      roleId = r.id;
    }
    if (roleId === undefined) throw new ToolUserError('Cần role_id hoặc role_name (xem list_invitations → roles). / role_id or role_name is required.');
    try {
      const inv = await createInvitation(deps.prisma, principal.user, { email: String(args.email), roleId }, await invitationScope(deps.scope, principal.user));
      const link = `${origin}${inv.path}`;
      const out = wrapData({
        invitation_id: inv.id,
        email: inv.email,
        role: inv.role_name,
        expires_at: iso(inv.expires_at),
        invite_link: link,
        next_step: 'Đưa nguyên invite_link cho người dùng để họ gửi qua Zalo/Messenger. Link chỉ hiện một lần.',
      });
      return { structured: out, text: JSON.stringify(out) };
    } catch (e) {
      if (e instanceof ConflictException || e instanceof ForbiddenException || e instanceof NotFoundException || e instanceof GoneException) {
        throw new ToolUserError(e.message);
      }
      throw e;
    }
  },
};

/** Huỷ lời mời còn hiệu lực (link chết ngay). Không xoá bản ghi; muốn mời lại thì create_invitation. */
export const cancelInvitationTool: ToolDef = {
  name: 'cancel_invitation',
  title: 'Huỷ lời mời nhân viên / Cancel a staff invitation',
  description:
    'Huỷ một lời mời còn hiệu lực (invitation_id lấy từ list_invitations): link chết ngay, người được mời không dùng được nữa. Không xoá gì, mời lại bằng create_invitation. ' +
    'Chỉ huỷ lời mời trong phạm vi users.manage của người dùng; chỉ làm khi CHÍNH người dùng yêu cầu. / Cancels a pending invitation (the link stops working); nothing is deleted.',
  permissions: ['users.manage'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({ invitation_id: z.number().int().min(1).max(2_147_483_647).describe('Id lời mời (list_invitations) / Invitation id') }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const id = Number(args.invitation_id);
    try {
      await revokeInvitation(deps.prisma, id, await invitationScope(deps.scope, principal.user));
    } catch (e) {
      if (e instanceof ConflictException || e instanceof NotFoundException) throw new ToolUserError(e.message);
      throw e;
    }
    const out = wrapData({ invitation_id: id, status: 'revoked' });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const INVITATION_TOOLS: readonly ToolDef[] = [listInvitationsTool, createInvitationTool, cancelInvitationTool];

