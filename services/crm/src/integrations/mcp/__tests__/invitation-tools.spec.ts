import { ConflictException, ForbiddenException } from '@nestjs/common';
import { createInvitationTool, listInvitationsTool } from '../tools/invitation-tools';
import { ToolUserError } from '../tools/tool-types';
import { MCP_TOOLS } from '../mcp-tools.registry';

jest.mock('@trinity/rbac-nest', () => ({
  ...jest.requireActual('@trinity/rbac-nest'),
  createInvitation: jest.fn(),
  listInvitations: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rbac = require('@trinity/rbac-nest') as { createInvitation: jest.Mock; listInvitations: jest.Mock };

const actor = { userId: 7, email: 'chu@x', isAdmin: false, grants: {} };
const ctx = (prisma: unknown) => ({ deps: { prisma }, baseUrl: 'https://crm.example/', principal: { userId: 7, user: actor } }) as never;
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
    expect(rbac.createInvitation).toHaveBeenCalledWith(prisma, actor, { email: 'nv@x.vn', roleId: 2 });
    expect(r.data.invite_link).toBe('https://crm.example/invite/c3.AbCdEf_-123');
    expect(r.data.expires_at).toBe('2026-12-03T00:00:00.000Z');
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
    prisma.role.findMany.mockResolvedValue([{ id: 2, name: 'Nhân viên', is_system: false }]);
    const r = (await listInvitationsTool.run({}, ctx(prisma))).structured as { data: { invitations: Array<Record<string, unknown>>; roles: unknown[] } };
    expect(rbac.listInvitations).toHaveBeenCalledWith(prisma, { pendingOnly: true });
    expect(r.data.invitations[0]).toMatchObject({ email: 'a@x.vn', role: 'Nhân viên', status: 'pending' });
    expect(JSON.stringify(r)).not.toMatch(/token|invite_link|invite\//);
    expect(r.data.roles).toEqual([{ id: 2, name: 'Nhân viên', system: false }]);
    await listInvitationsTool.run({ all: true }, ctx(prisma));
    expect(rbac.listInvitations).toHaveBeenLastCalledWith(prisma, { pendingOnly: false });
  });
});
