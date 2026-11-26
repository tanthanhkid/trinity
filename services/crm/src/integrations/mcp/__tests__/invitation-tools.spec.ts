import { ConflictException, ForbiddenException } from '@nestjs/common';
import { cancelInvitationTool, createInvitationTool, listInvitationsTool } from '../tools/invitation-tools';
import { ToolUserError } from '../tools/tool-types';
import { MCP_TOOLS } from '../mcp-tools.registry';

jest.mock('@trinity/rbac-nest', () => ({
  ...jest.requireActual('@trinity/rbac-nest'),
  createInvitation: jest.fn(),
  listInvitations: jest.fn(),
  revokeInvitation: jest.fn(),
  invitationScope: jest.fn().mockResolvedValue('all'),
  invitableRoles: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rbac = require('@trinity/rbac-nest') as { createInvitation: jest.Mock; listInvitations: jest.Mock; revokeInvitation: jest.Mock; invitationScope: jest.Mock; invitableRoles: jest.Mock };

const actor = { userId: 7, email: 'chu@x', isAdmin: false, grants: {} };
const scope = { ownerIds: jest.fn() };
const ctx = (prisma: unknown, baseUrl = 'https://crm.example/') => ({ deps: { prisma, scope }, baseUrl, principal: { userId: 7, user: actor } }) as never;
const prisma = { role: { findFirst: jest.fn(), findMany: jest.fn() } };

beforeEach(() => jest.clearAllMocks());

describe('create_invitation', () => {
  it('cần quyền users.manage + scope crm.write; có trong registry', () => {
    expect(createInvitationTool.permissions).toEqual(['users.manage']);
    expect(createInvitationTool.scope).toBe('crm.write');
    expect(listInvitationsTool.permissions).toEqual(['users.manage']);
    expect(MCP_TOOLS.some((t) => t.name === 'create_invitation')).toBe(true);
    expect(MCP_TOOLS.some((t) => /^(delete|remove|revoke)_.*invit/.test(t.name))).toBe(false);
  });

  it('trả invite_link đầy đủ theo địa chỉ gốc, bằng quyền (đã giới hạn cho AI) của người dùng', async () => {
    rbac.createInvitation.mockResolvedValue({ id: 5, email: 'nv@x.vn', role_name: 'Nhân viên', expires_at: new Date('2026-12-03T00:00:00Z'), path: '/invite/c3.AbCdEf_-123' });
    const r = (await createInvitationTool.run({ email: 'nv@x.vn', role_id: 2 }, ctx(prisma))).structured as { data: Record<string, unknown> };
    expect(rbac.createInvitation).toHaveBeenCalledWith(prisma, actor, { email: 'nv@x.vn', roleId: 2 }, 'all');
    expect(r.data.invite_link).toBe('https://crm.example/invite/c3.AbCdEf_-123');
    expect(r.data.expires_at).toBe('2026-12-03T00:00:00.000Z');
  });

  it('thiếu địa chỉ công khai ⇒ lỗi rõ, KHÔNG tạo lời mời, không trả đường dẫn tương đối', async () => {
    for (const bad of ['', '   ', '/']) {
      await expect(createInvitationTool.run({ email: 'a@x.vn', role_id: 2 }, ctx(prisma, bad))).rejects.toThrow(/địa chỉ công khai/);
    }
    expect(rbac.createInvitation).not.toHaveBeenCalled();
  });

  it('role_name tra ra id; tên lạ báo lỗi, không tạo', async () => {
    prisma.role.findFirst.mockResolvedValueOnce({ id: 9 });
    rbac.createInvitation.mockResolvedValue({ id: 1, email: 'a@x.vn', role_name: 'Kế toán', expires_at: new Date(), path: '/invite/x' });
    await createInvitationTool.run({ email: 'a@x.vn', role_name: 'kế toán' }, ctx(prisma));
    expect(rbac.createInvitation.mock.calls[0][2]).toEqual({ email: 'a@x.vn', roleId: 9 });
    prisma.role.findFirst.mockResolvedValueOnce(null);
    await expect(createInvitationTool.run({ email: 'a@x.vn', role_name: 'không có' }, ctx(prisma))).rejects.toBeInstanceOf(ToolUserError);
    await expect(createInvitationTool.run({ email: 'a@x.vn' }, ctx(prisma))).rejects.toBeInstanceOf(ToolUserError);
    expect(rbac.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('vượt gói / email công ty khác / vai trò quá quyền ⇒ lỗi tiếng Việt cho AI (không phải lỗi hệ thống)', async () => {
    rbac.createInvitation.mockRejectedValueOnce(new ConflictException('Gói hiện tại tối đa 10 người, liên hệ để nâng gói.'));
    await expect(createInvitationTool.run({ email: 'a@x.vn', role_id: 2 }, ctx(prisma))).rejects.toThrow('tối đa 10 người');
    rbac.createInvitation.mockRejectedValueOnce(new ForbiddenException('Chỉ Quản trị mới được mời vào vai trò Quản trị'));
    await expect(createInvitationTool.run({ email: 'a@x.vn', role_id: 1 }, ctx(prisma))).rejects.toBeInstanceOf(ToolUserError);
    rbac.createInvitation.mockRejectedValueOnce(new Error('db down'));
    await expect(createInvitationTool.run({ email: 'a@x.vn', role_id: 1 }, ctx(prisma))).rejects.not.toBeInstanceOf(ToolUserError);
  });
});

describe('list_invitations', () => {
  it('liệt kê không kèm link/token, kèm vai trò mời được', async () => {
    rbac.listInvitations.mockResolvedValue([{ id: 1, email: 'a@x.vn', role_id: 2, role_name: 'Nhân viên', status: 'pending', expires_at: new Date('2026-12-01T00:00:00Z'), created_at: new Date('2026-11-24T00:00:00Z') }]);
    rbac.invitableRoles.mockResolvedValue([{ id: 2, name: 'Nhân viên', is_system: false }]);
    const r = (await listInvitationsTool.run({}, ctx(prisma))).structured as { data: { invitations: Array<Record<string, unknown>>; roles: unknown[] } };
    expect(rbac.listInvitations).toHaveBeenCalledWith(prisma, { pendingOnly: true, owners: 'all' });
    expect(r.data.invitations[0]).toMatchObject({ email: 'a@x.vn', role: 'Nhân viên', status: 'pending' });
    expect(JSON.stringify(r)).not.toMatch(/token|invite_link|invite\//);
    expect(r.data.roles).toEqual([{ id: 2, name: 'Nhân viên', system: false }]);
    await listInvitationsTool.run({ all: true }, ctx(prisma));
    expect(rbac.listInvitations).toHaveBeenLastCalledWith(prisma, { pendingOnly: false, owners: 'all' });
  });
  it('phạm vi hẹp của users.manage được chuyển xuống', async () => {
    rbac.invitationScope.mockResolvedValueOnce([7, 8]);
    rbac.listInvitations.mockResolvedValue([]);
    rbac.invitableRoles.mockResolvedValue([]);
    await listInvitationsTool.run({}, ctx(prisma));
    expect(rbac.listInvitations).toHaveBeenLastCalledWith(prisma, { pendingOnly: true, owners: [7, 8] });
  });
});

describe('cancel_invitation', () => {
  it('huỷ theo phạm vi; cần users.manage + crm.write; không đụng mật khẩu', async () => {
    expect(cancelInvitationTool.permissions).toEqual(['users.manage']);
    expect(cancelInvitationTool.scope).toBe('crm.write');
    expect(MCP_TOOLS.some((t) => /password/i.test(t.name))).toBe(false);
    rbac.invitationScope.mockResolvedValueOnce([7]);
    rbac.revokeInvitation.mockResolvedValue(undefined);
    const r = (await cancelInvitationTool.run({ invitation_id: 5 }, ctx(prisma))).structured as { data: Record<string, unknown> };
    expect(rbac.revokeInvitation).toHaveBeenCalledWith(prisma, 5, [7]);
    expect(r.data).toMatchObject({ invitation_id: 5, status: 'revoked' });
  });
  it('lời mời không còn hiệu lực / ngoài phạm vi ⇒ lỗi cho AI', async () => {
    rbac.revokeInvitation.mockRejectedValueOnce(new ConflictException('Lời mời này không còn hiệu lực để huỷ'));
    await expect(cancelInvitationTool.run({ invitation_id: 5 }, ctx(prisma))).rejects.toBeInstanceOf(ToolUserError);
  });
});
