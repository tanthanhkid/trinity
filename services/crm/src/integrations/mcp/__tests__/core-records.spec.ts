import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { archiveRecordAction } from '../actions/action-archive-record';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError, type ActionCtx, type ActionDeps } from '../actions/action-types';
import type { McpPrincipal } from '../mcp-auth.service';
import { describeSchemaTool } from '../tools/schema-tools';
import { getRecordTool, listRecordsTool } from '../tools/record-tools';
import { ToolUserError, type McpDeps, type ToolContext } from '../tools/tool-types';

/** Cây cấp bậc giả: lead 10 quản lý 11, 12; sale 20 thuộc nhóm khác. ownerIds giả lập đúng ngữ nghĩa own/team/subtree/all của ScopeService. */
const TEAM: Record<number, number[]> = { 10: [11, 12], 20: [21] };
const scope = {
  ownerIds: jest.fn(async (u: AuthUser, p: string) => {
    const g = (u.grants as Record<string, unknown>)[p];
    if (g === undefined) return null;
    if (g === true || g === 'all') return 'all';
    if (g === 'own') return [u.userId];
    return [u.userId, ...(TEAM[u.userId] ?? [])];
  }),
};
const user = (grants: Record<string, unknown>, id: number): AuthUser => ({ userId: id, email: `u${id}@x.vn`, isAdmin: false, grants: grants as Grants });
const SALE = user({ 'contacts.view': 'own', 'contacts.create': 'own', 'contacts.update': 'own', 'deals.view': 'own', 'kanban.view': 'own', 'custom_records.view': 'own', 'custom_records.manage': 'own' }, 11);
const LEAD = user({ ...SALE.grants, 'contacts.view': 'team', 'contacts.update': 'team', 'custom_records.view': 'team', 'custom_records.manage': 'team', 'custom_records.delete': 'team', 'deals.manage': 'team' }, 10);
const ADMIN = user({ 'contacts.view': 'all', 'contacts.create': 'all', 'contacts.update': 'all', 'deals.view': 'all', 'deals.manage': 'all', 'custom_records.view': 'all', 'custom_records.manage': 'all', 'custom_records.delete': 'all', 'custom_objects.manage': true }, 1);

const principal = (u: AuthUser): McpPrincipal => ({ userId: u.userId, email: u.email, clientId: 'c', scopes: ['crm.read', 'crm.write'], tokenId: BigInt(1), user: u });
const ctx = (deps: McpDeps, u: AuthUser): ToolContext => ({ principal: principal(u), deps, baseUrl: 'https://x' });
const actx = (deps: ActionDeps, u: AuthUser): ActionCtx => ({ deps, user: u });

function deps(over: Record<string, unknown> = {}) {
  const prisma = {
    contact: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findUnique: jest.fn() },
    settingOption: { findUnique: jest.fn().mockResolvedValue({ group_key: 'contact_source', label: 'Facebook', is_active: true }) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    customObject: { findFirst: jest.fn().mockResolvedValue({ id: 1, key: 'benh_nhan', label: 'Bệnh nhân', label_plural: 'Bệnh nhân', is_active: true, deleted_at: null, visible_role_ids: [] }), findMany: jest.fn().mockResolvedValue([]) },
    customView: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    customField: { findMany: jest.fn().mockResolvedValue([]) },
    customRecord: { findFirst: jest.fn() },
  };
  return {
    prisma, scope,
    contacts: { create: jest.fn().mockResolvedValue({ contact: { id: 5 } }), update: jest.fn().mockResolvedValue({}), findById: jest.fn() },
    deals: { findAll: jest.fn().mockResolvedValue({ data: [], meta: { next_cursor: null } }), findOne: jest.fn(), create: jest.fn().mockResolvedValue({ id: 9 }), update: jest.fn().mockResolvedValue({}) },
    cards: { list: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn() },
    records: { remove: jest.fn().mockResolvedValue({ ok: true }) },
    ...over,
  } as never as McpDeps & ActionDeps & { prisma: typeof prisma };
}

describe('list_records / get_record trên bảng lõi', () => {
  it('contacts: gửi sang list_contacts với phạm vi của chính người dùng; filter lạ bị từ chối', async () => {
    const d = deps();
    const out = await listRecordsTool.run({ object: 'contacts', filter: { assigned_to: 11 }, search: 'Test', limit: 5 }, ctx(d, SALE));
    expect(d.prisma.contact.findMany).toHaveBeenCalled();
    expect((out.structured.data as { object: string }).object).toBe('contacts');
    await expect(listRecordsTool.run({ object: 'contacts', filter: { cccd: '1' } }, ctx(d, SALE))).rejects.toBeInstanceOf(ToolUserError);
  });
  it('thiếu quyền xem bảng lõi ⇒ 403 nêu tên quyền', async () => {
    const d = deps();
    await expect(listRecordsTool.run({ object: 'deals' }, ctx(d, user({}, 3)))).rejects.toThrow(/deals\.view/);
    await expect(getRecordTool.run({ object: 'tasks', id: 1 }, ctx(d, user({}, 3)))).rejects.toThrow(/kanban\.view/);
  });
  it('deals: list gọi DealsService.findAll với người dùng thật (phạm vi do service áp)', async () => {
    const d = deps();
    await listRecordsTool.run({ object: 'deals', filter: { status: 'open' } }, ctx(d, LEAD));
    expect(d.deals.findAll).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }), LEAD);
  });
  it('get_record deals ngoài phạm vi ⇒ NotFound từ service (không lộ)', async () => {
    const d = deps();
    (d.deals.findOne as jest.Mock).mockRejectedValue(new NotFoundException());
    await expect(getRecordTool.run({ object: 'deals', id: 7 }, ctx(d, SALE))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('create_record / update_record trên bảng lõi', () => {
  const create = actionToolByName('create_record')!;
  const update = actionToolByName('update_record')!;
  it('contacts: nháp mang tham số đã chuẩn hoá, SĐT che trong tóm tắt; duyệt gọi ContactsService.create với người duyệt', async () => {
    const d = deps();
    const p = await create.prepare({ object: 'contacts', values: { full_name: 'Nguyễn Văn Test', phone: '0987654321', source_id: 3 } }, actx(d, SALE));
    expect(p.params).toMatchObject({ object: 'contacts', values: { full_name: 'Nguyễn Văn Test', source_id: 3 } });
    expect(JSON.stringify({ s: p.summary, d: p.details })).not.toContain('0987654321'); // params giữ SĐT đủ để ghi, không bao giờ trả ra AI
    const r = await create.execute(p.params, actx(d, SALE), 1);
    expect(d.contacts.create).toHaveBeenCalledWith(expect.objectContaining({ full_name: 'Nguyễn Văn Test' }), SALE);
    expect(r).toMatchObject({ object: 'contacts', contact_id: 5 });
  });
  it('thiếu quyền ghi bảng lõi ⇒ từ chối cả lúc tạo nháp lẫn lúc duyệt (quyền có thể đã đổi)', async () => {
    const d = deps();
    const noWrite = user({ 'contacts.view': 'own', 'deals.view': 'own' }, 30);
    await expect(create.prepare({ object: 'contacts', values: { full_name: 'A', phone: '0987654321', source_id: 3 } }, actx(d, noWrite))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(create.prepare({ object: 'deals', values: { title: 'x' } }, actx(d, SALE))).rejects.toThrow(/deals\.manage/);
    await expect(create.execute({ object: 'deals', values: { title: 'x', assigned_to: 11 } }, actx(d, SALE), 1)).rejects.toBeInstanceOf(ForbiddenException);
    expect(d.deals.create).not.toHaveBeenCalled();
  });
  it('deals: giao cho người ngoài phạm vi quản lý ⇒ báo lỗi sớm; trong phạm vi thì ra nháp', async () => {
    const d = deps();
    await expect(create.prepare({ object: 'deals', values: { title: 'Gói A', assigned_to: 20 } }, actx(d, LEAD))).rejects.toBeInstanceOf(ActionUserError);
    const p = await create.prepare({ object: 'deals', values: { title: 'Gói A', assigned_to: 12, value: 1000 } }, actx(d, LEAD));
    expect(p.summary).toContain('Gói A');
  });
  it('update contacts: chỉ trường cho phép (cccd/phone bị từ chối); khách ngoài phạm vi ⇒ không tìm thấy', async () => {
    const d = deps();
    await expect(update.prepare({ object: 'contacts', id: 1, values: { cccd: '123' } }, actx(d, ADMIN))).rejects.toThrow(/chỉ sửa được/);
    await expect(update.prepare({ object: 'contacts', id: 1, values: { phone: '0900000001' } }, actx(d, ADMIN))).rejects.toThrow(/chỉ sửa được/);
    (d.prisma.contact.findFirst as jest.Mock).mockResolvedValue({ id: 1, full_name: 'X', assigned_to: 20, created_by_id: 20, stage_id: null, stage: null });
    await expect(update.prepare({ object: 'contacts', id: 1, values: { job_title: 'Bác sĩ' } }, actx(d, SALE))).rejects.toBeInstanceOf(NotFoundException);
    const ok = await update.prepare({ object: 'contacts', id: 1, values: { job_title: 'Bác sĩ' } }, actx(d, ADMIN));
    expect(ok.params).toEqual({ object: 'contacts', id: 1, values: { job_title: 'Bác sĩ' } });
    await update.execute(ok.params, actx(d, ADMIN), 2);
    expect(d.contacts.update).toHaveBeenCalledWith(1, expect.objectContaining({ job_title: 'Bác sĩ' }), ADMIN);
  });
});

describe('archive_record (xoá mềm qua nháp)', () => {
  const row = { id: 4, object_id: 1, title: 'An', owner_id: 11, created_by: 11, deleted_at: null };
  it('lead (team) lưu trữ được bản ghi của cấp dưới; sale thiếu custom_records.delete bị chặn ở tầng tool', async () => {
    const d = deps(); (d.prisma.customRecord.findFirst as jest.Mock).mockResolvedValue(row);
    const p = await archiveRecordAction.prepare({ object: 'benh_nhan', id: 4 }, actx(d, LEAD));
    expect(p.summary).toContain('Lưu trữ');
    await archiveRecordAction.execute(p.params, actx(d, LEAD), 1);
    expect(d.records.remove).toHaveBeenCalledWith(LEAD, 'benh_nhan', 4);
    expect(archiveRecordAction.permissions).toContain('custom_records.delete');
  });
  it('bản ghi của nhóm khác ⇒ không tìm thấy; bảng lõi ⇒ từ chối', async () => {
    const d = deps(); (d.prisma.customRecord.findFirst as jest.Mock).mockResolvedValue({ ...row, owner_id: 21, created_by: 21 });
    await expect(archiveRecordAction.prepare({ object: 'benh_nhan', id: 4 }, actx(d, LEAD))).rejects.toThrow(/ngoài phạm vi/);
    await expect(archiveRecordAction.prepare({ object: 'contacts', id: 4 }, actx(d, ADMIN))).rejects.toThrow(/bảng lõi/);
  });
});

describe('describe_schema theo vai trò', () => {
  it('data_scope: sale own, lead team, admin all; chỉ admin có structure.can_edit', async () => {
    const d = deps();
    (d.prisma.customObject.findMany as jest.Mock).mockResolvedValue([{ id: 1, key: 'benh_nhan', label: 'Bệnh nhân', label_plural: 'Bệnh nhân', description: null, is_active: true, deleted_at: null, visible_role_ids: [], nav_order: 1 }]);
    const scopes: Record<string, string | null> = {};
    const edit: Record<string, boolean> = {};
    for (const [n, u] of [['sales', SALE], ['lead', LEAD], ['admin', ADMIN]] as const) {
      const out = await describeSchemaTool.run({}, ctx(d, u));
      const data = out.structured.data as { tables: { key: string; data_scope: string }[]; structure: { can_edit: boolean } };
      scopes[n] = data.tables.find((t) => t.key === 'benh_nhan')?.data_scope ?? null;
      edit[n] = data.structure.can_edit;
    }
    expect(scopes).toEqual({ sales: 'own', lead: 'team', admin: 'all' });
    const core = (await describeSchemaTool.run({}, ctx(d, LEAD))).structured.data as { tables: { key: string; data_scope: string }[] };
    expect(core.tables.find((t) => t.key === 'contacts')?.data_scope).toBe('team');
    expect(edit).toEqual({ sales: false, lead: false, admin: true });
  });
  it('mô tả một bảng ⇒ other_tables liệt kê các bảng còn lại (để tìm dữ liệu liên quan ở bảng khác)', async () => {
    const d = deps();
    (d.prisma.customObject.findMany as jest.Mock).mockResolvedValue([{ id: 1, key: 'benh_nhan', label: 'Bệnh nhân', label_plural: 'Bệnh nhân', description: null, is_active: true, deleted_at: null, visible_role_ids: [], nav_order: 1 }]);
    const one = (await describeSchemaTool.run({ object: 'contacts' }, ctx(d, ADMIN))).structured.data as { tables: { key: string }[]; other_tables: { key: string }[] };
    expect(one.tables.map((t) => t.key)).toEqual(['contacts']);
    expect(one.other_tables.map((t) => t.key)).toEqual(expect.arrayContaining(['benh_nhan', 'deals']));
    expect(one.other_tables.map((t) => t.key)).not.toContain('contacts');
    const all = (await describeSchemaTool.run({}, ctx(d, ADMIN))).structured.data as Record<string, unknown>;
    expect(all.other_tables).toBeUndefined();
  });
});
