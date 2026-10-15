import { z } from 'zod';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { CustomViewsService } from '../../../custom-objects/custom-views.service';
import { codeTitleOrTextSql } from '../../../custom-objects/custom-records-list.service';
import { viewTypesInWords, VIEW_TYPE_INFO } from '../../../custom-objects/view-config';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError, type ActionCtx, type ActionDeps } from '../actions/action-types';
import { AiActionsService } from '../actions/ai-actions.service';
import { isUserConfirmation } from '../actions/user-confirmation';
import { MCP_TOOLS } from '../mcp-tools.registry';
import { activityRange, listAiActivityTool, vnIso, vnToday } from '../tools/ai-activity-tool';
import { totalCounts } from '../tools/record-tools';
import { ForbiddenToolError, ToolUserError } from '../tools/tool-types';

/** Các chốt chặn rút ra từ lượt chạy Haiku: AI hỏi loại màn, hỏi trước khi tạo bảng, xem được AI đã làm gì. */
describe('loại màn do người dùng chọn (type_words)', () => {
  it('lời không nêu loại ⇒ không ra loại nào; tên bảng/màn không tính', () => {
    expect(viewTypesInWords('chỗ quản lý lịch hẹn khách', ['Lịch hẹn', 'Lịch hẹn', 'lich hen'])).toEqual([]);
    expect(viewTypesInWords('màn theo dõi đơn hàng', ['Đơn hàng'])).toEqual([]);
    expect(viewTypesInWords('', [])).toEqual([]);
    expect(viewTypesInWords(undefined, [])).toEqual([]);
  });
  it('lời nêu loại ⇒ nhận đúng loại, kể cả khi bảng tên “Lịch hẹn”', () => {
    expect(viewTypesInWords('xem dạng lịch theo tháng', ['Lịch hẹn'])).toContain('calendar');
    expect(viewTypesInWords('lịch hẹn dạng lịch', ['Lịch hẹn'])).toContain('calendar');
    expect(viewTypesInWords('kéo thả theo trạng thái', [])).toContain('kanban');
    expect(viewTypesInWords('lấy kiểu bảng sửa nhanh đi', [])).toContain('table');
    expect(viewTypesInWords('danh sách thôi', [])).toContain('list');
    expect(viewTypesInWords('Kanban', [])).toEqual(['kanban']);
  });
  it('kanban trong danh mục nói rõ chỉ chia cột theo trường select', () => {
    expect(VIEW_TYPE_INFO.find((t) => t.type === 'kanban')!.summary).toMatch(/Chỉ chia cột theo trường select/);
  });
});

const FIELDS = [
  { id: 1, object_id: 77, key: 'ten', label: 'Tên', type: 'text', required: true, is_unique: false, is_title: true, show_in_list: true, sort_order: 10, options: {}, help_text: null },
  { id: 2, object_id: 77, key: 'trang_thai', label: 'Trạng thái', type: 'select', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 20, options: { choices: [{ value: 'moi', label: 'Mới' }] }, help_text: null },
  { id: 3, object_id: 77, key: 'thoi_gian_hen', label: 'Thời gian hẹn', type: 'datetime', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 30, options: {}, help_text: null },
];
const ADMIN: AuthUser = { userId: 1, email: 'a@x.vn', isAdmin: false, grants: { 'custom_objects.manage': true, 'settings.features': true, 'custom_records.view': 'all', 'custom_records.manage': 'all' } as unknown as Grants };
function deps() {
  const prisma = {
    customObject: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockImplementation(async ({ where }: { where: { key: string } }) => (where.key === 'lich_hen' ? { id: 77, key: 'lich_hen', label: 'Lịch hẹn', label_plural: 'Lịch hẹn', is_active: true, deleted_at: null, visible_role_ids: [] } : null)),
    },
    customView: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue({ key: 'ds', label: 'Danh sách', type: 'list', config: {}, icon: null, show_in_nav: true }) },
    customField: { findMany: jest.fn().mockResolvedValue(FIELDS) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    role: { findMany: jest.fn().mockResolvedValue([]) },
    customRecord: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockImplementation(async (q: { sql: string }) => (q.sql.includes('trinity_pick_code_prefix') ? [{ p: 'PB' }] : [{ taken: false, n: 0 }])),
  };
  return {
    prisma,
    views: Object.assign(new CustomViewsService(prisma as never), { create: jest.fn() }),
    objects: { create: jest.fn() }, fields: { create: jest.fn() },
    templates: { list: jest.fn().mockResolvedValue([{ key: 'education_center' }]), apply: jest.fn() },
    setup: { get: jest.fn().mockResolvedValue('da_dung') },
    orgFeatures: { stored: jest.fn().mockResolvedValue(undefined) },
    menu: { resolve: jest.fn().mockResolvedValue([]) },
  } as never as ActionDeps;
}
const prep = (n: string, args: Record<string, unknown>) => actionToolByName(n)!.prepare(args, { deps: deps(), user: ADMIN } as ActionCtx);

describe('create_view / update_view / propose_workspace: thiếu lời chọn loại ⇒ từ chối kèm 4 loại', () => {
  const view = { object: 'lich_hen', label: 'Lịch hẹn', type: 'calendar', date_field: 'thoi_gian_hen' };
  it('create_view: "quản lý lịch hẹn" bị từ chối, "dạng lịch" qua', async () => {
    const err = await prep('create_view', { ...view, type_words: 'chỗ quản lý lịch hẹn' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionUserError);
    expect((err as Error).message).toMatch(/list.*kanban.*calendar.*table/s);
    await expect(prep('create_view', { ...view, type_words: '' })).rejects.toBeInstanceOf(ActionUserError);
    await expect(prep('create_view', { ...view, type_words: 'kanban' })).rejects.toBeInstanceOf(ActionUserError);
    await expect(prep('create_view', { ...view, type_words: 'xem dạng lịch' })).resolves.toBeTruthy();
  });
  it('update_view: đổi loại cần lời chọn loại; đổi tên thì không', async () => {
    await expect(prep('update_view', { object: 'lich_hen', view: 'ds', type: 'kanban', group_by: 'trang_thai' })).rejects.toBeInstanceOf(ActionUserError);
    await expect(prep('update_view', { object: 'lich_hen', view: 'ds', type: 'kanban', group_by: 'trang_thai', type_words: 'chia cột theo trạng thái' })).resolves.toBeTruthy();
    await expect(prep('update_view', { object: 'lich_hen', view: 'ds', label: 'Tất cả' })).resolves.toBeTruthy();
  });
  it('propose_workspace: view thiếu lời chọn loại ⇒ từ chối', async () => {
    const goi = { title: 'G', confirmed_by_user: 'ok', objects: [{ key: 'phieu_bh', label: 'Phiếu bảo hành', fields: [{ label: 'Tên', type: 'text' }] }], views: [{ object: 'phieu_bh', label: 'Phiếu', type: 'list' }] };
    await expect(prep('propose_workspace', goi)).rejects.toThrow(/list/);
  });
});

describe('tạo bảng mới cần lời người dùng đồng ý (confirmed_by_user)', () => {
  it('isUserConfirmation: đồng ý / từ chối / yêu cầu ban đầu', () => {
    for (const yes of ['ok', 'Ok tạo đi', 'đồng ý', 'được đó', 'chốt', 'ừ làm luôn', 'yes', 'đúng rồi, không cần thêm gì']) expect([yes, isUserConfirmation(yes)]).toEqual([yes, true]);
    for (const no of ['', 'không', 'chưa, thêm cột ghi chú', 'khoan đã', 'tạo cho mình bảng quản lý phiếu bảo hành', 'thêm trường số serial']) expect([no, isUserConfirmation(no)]).toEqual([no, false]);
    expect(isUserConfirmation(undefined)).toBe(false);
  });
  it('lời yêu cầu đã nói rõ tạo ngay (tạo luôn / khỏi hỏi lại) là lời đồng ý — Thanh chốt cách 1', () => {
    for (const yes of ['Mình mở tiệm sửa máy lạnh, tạo luôn cho mình bảng phiếu bảo hành, xem dạng kanban theo trạng thái nha', 'tạo bảng phiếu bảo hành, khỏi hỏi lại nha',
      'làm bảng khách hàng, không cần hỏi lại', 'tạo ngay bảng đơn hàng', 'đừng hỏi lại, làm luôn']) expect([yes, isUserConfirmation(yes)]).toEqual([yes, true]);
    for (const no of ['tạo bảng phiếu bảo hành rồi hỏi mình cột nhé', 'khỏi hỏi lại nhưng thêm cột giá']) expect([no, isUserConfirmation(no)]).toEqual([no, false]);
  });
  it('mô tả confirmed_by_user nói rõ lời yêu cầu "tạo luôn / khỏi hỏi lại" là lời đồng ý (để AI chép lên)', () => {
    for (const name of ['create_objects', 'create_object', 'propose_workspace', 'install_object_template']) {
      const t = actionToolByName(name)!;
      const shape = t.input(z) as Record<string, { description?: string }>;
      expect([name, /tạo luôn/.test(shape.confirmed_by_user.description ?? '') && /khỏi hỏi lại/.test(shape.confirmed_by_user.description ?? '')]).toEqual([name, true]);
      expect([name, /khỏi hỏi lại/.test(t.description)]).toEqual([name, true]);
    }
  });
  const obj = { key: 'phieu_bh', label: 'Phiếu bảo hành', fields: [{ label: 'Tên', type: 'text' }, { label: 'Hạn', type: 'date' }] };
  it('create_objects / create_object: chưa đồng ý ⇒ không tạo, trả cấu trúc dự kiến để hỏi', async () => {
    const err = await prep('create_objects', { objects: [obj], confirmed_by_user: 'tạo bảng phiếu bảo hành' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionUserError);
    expect((err as Error).message).toMatch(/Chưa tạo gì/);
    expect((err as Error).message).toContain('Hạn');
    await expect(prep('create_object', obj)).rejects.toBeInstanceOf(ActionUserError);
    await expect(prep('create_objects', { objects: [obj], confirmed_by_user: 'ok' })).resolves.toBeTruthy();
    await expect(prep('create_object', { ...obj, confirmed_by_user: 'đồng ý' })).resolves.toBeTruthy();
  });
  it('propose_workspace: chưa đồng ý ⇒ không dựng gói', async () => {
    const goi = { title: 'Bảo hành', objects: [obj], views: [{ object: 'phieu_bh', label: 'Phiếu', type: 'list', type_words: 'danh sách' }] };
    await expect(prep('propose_workspace', goi)).rejects.toThrow(/Chưa tạo gì/);
    await expect(prep('propose_workspace', { ...goi, confirmed_by_user: 'chốt vậy' })).resolves.toBeTruthy();
  });
  it('install_object_template: mẫu tạo bảng mới cần đồng ý', async () => {
    await expect(prep('install_object_template', { template: 'education_center' })).rejects.toThrow(/Chưa tạo gì/);
  });
});

describe('list_ai_activity', () => {
  const now = new Date('2026-10-12T03:00:00Z'); // 10:00 giờ VN
  it('activityRange: mặc định hôm nay theo giờ VN; một ngày; khoảng; lỗi', () => {
    expect(vnToday(new Date('2026-10-11T18:30:00Z'))).toBe('2026-10-12');
    expect(vnIso(new Date('2026-10-12T11:26:05.123Z'))).toBe('2026-10-12T18:26:05+07:00');
    const r = activityRange(undefined, undefined, now);
    expect(r.from.toISOString()).toBe('2026-10-11T17:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-10-12T17:00:00.000Z');
    expect(activityRange('2026-10-05', undefined, now).label).toBe('2026-10-05');
    expect(activityRange('2026-10-05', '2026-10-11', now).label).toBe('2026-10-05 → 2026-10-11');
    expect(() => activityRange('hôm qua', undefined, now)).toThrow(ToolUserError);
    expect(() => activityRange('2026-10-10', '2026-10-01', now)).toThrow(ToolUserError);
    expect(() => activityRange('2026-01-01', '2026-10-01', now)).toThrow(/92/);
  });
  const ctx = (grants: Record<string, unknown>, activity: jest.Mock) => ({ deps: { actions: { activity } } as never, principal: { userId: 5, scopes: ['crm.read'], user: { userId: 5, grants } } as never, baseUrl: 'http://x' });
  it('mặc định chỉ của chính người dùng; all_users cần integrations.ai_admin', async () => {
    const activity = jest.fn().mockResolvedValue({ items: [{ action_id: 1, at: new Date('2026-10-12T11:26:05Z') }], next_cursor: null });
    const out = await listAiActivityTool.run({}, ctx({}, activity));
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ userId: 5, limit: 20 }));
    expect(out.text).toContain('chính bạn');
    expect(out.text).toContain('2026-10-12T18:26:05+07:00');
    await expect(listAiActivityTool.run({ all_users: true }, ctx({}, activity))).rejects.toBeInstanceOf(ForbiddenToolError);
    await listAiActivityTool.run({ all_users: true, status: 'failed' }, ctx({ 'integrations.ai_admin': true }, activity));
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ userId: null, status: 'failed' }));
  });
  it('chỉ cần crm.read, không cần quyền nghiệp vụ', () => {
    expect(listAiActivityTool.permissions).toEqual([]);
    expect(MCP_TOOLS.some((t) => t.name === 'list_ai_activity')).toBe(true);
  });
  it('AiActionsService.activity: lọc theo người + khoảng ngày, giấu lý do lỗi, có next_cursor', async () => {
    const svc = Object.create(AiActionsService.prototype) as AiActionsService;
    const row = (id: number, status: string) => ({ id, user_id: 5, client_id: 'c', tool: 'update_record', summary: `s${id}`, details: null, status, result: null, error: 'lỗi 0901234567', created_at: now, decided_at: null, expires_at: new Date('2099-01-01'), impact: null });
    const prisma = {
      aiActionDraft: { findMany: jest.fn().mockResolvedValue([row(9, 'executed'), row(8, 'failed'), row(7, 'executed')]) },
      oauthClient: { findMany: jest.fn().mockResolvedValue([{ client_id: 'c', name: 'Claude' }]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 5, full_name: 'Thanh' }]) },
    };
    Object.assign(svc, { prisma });
    const from = new Date('2026-10-11T17:00:00Z'); const to = new Date('2026-10-12T17:00:00Z');
    const r = await svc.activity({ userId: 5, from, to, limit: 2 });
    expect(prisma.aiActionDraft.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { created_at: { gte: from, lt: to }, user_id: 5 }, take: 3 }));
    expect(r.items).toHaveLength(2);
    expect(r.next_cursor).toBe(8);
    expect(r.items[0]).toMatchObject({ action_id: 9, user: 'Thanh', app: 'Claude', open_at: '/ai-actions?id=9' });
    expect(r.items[1].error).not.toContain('0901234567');
    await svc.activity({ userId: null, from, to, limit: 2 });
    expect(prisma.aiActionDraft.findMany.mock.calls[1][0].where).not.toHaveProperty('user_id');
  });
});

describe('tìm bản ghi & mô tả tool', () => {
  it('codeTitleOrTextSql: tìm thêm trong các trường chữ, không có trường chữ thì như cũ', () => {
    const sql = codeTitleOrTextSql('trà sữa', ['ten_don', 'ghi_chu']);
    expect(sql.sql).toMatch(/data->>.*ILIKE.*OR.*data->>.*ILIKE/s);
    expect(sql.values).toEqual(expect.arrayContaining(['ten_don', 'ghi_chu', '%trà sữa%']));
    expect(codeTitleOrTextSql('x', []).sql).not.toContain('data->>');
  });
  it('totalCounts nói rõ total là số khớp tìm/lọc chứ không phải cả bảng', () => {
    expect(totalCounts('trà sữa', undefined, 2)).toMatch(/không phải cả bảng/);
    expect(totalCounts(undefined, undefined, 8)).toMatch(/toàn bộ/);
    expect(totalCounts('x', undefined, null)).toMatch(/trang đầu/);
  });
  const desc = (n: string) => MCP_TOOLS.find((t) => t.name === n)?.description ?? actionToolByName(n)!.description;
  it('search nói không gồm bảng tự tạo; create_task nói contact_id lấy ở đâu', () => {
    expect(desc('search')).toMatch(/list_records/);
    const shape = actionToolByName('create_task')!.input(z) as Record<string, { description?: string }>;
    expect(shape.contact_id.description).toMatch(/search.*list_contacts/);
  });
});
