import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError, type ActionCtx, type ActionDeps } from '../actions/action-types';
import { McpServerService } from '../mcp-server.service';
import { MCP_TOOLS } from '../mcp-tools.registry';
import type { McpPrincipal } from '../mcp-auth.service';

const user = (grants: Record<string, unknown>, id: number): AuthUser => ({ userId: id, email: 'u@x.vn', isAdmin: false, grants: grants as Grants });
const ADMIN = user({ 'custom_objects.manage': true, 'custom_records.view': 'all', 'custom_records.manage': 'all' }, 1);
const LEAD = user({ 'custom_records.view': 'team', 'custom_records.manage': 'team', 'custom_records.delete': 'team', 'contacts.view': 'team' }, 10);
const SALE = user({ 'custom_records.view': 'own', 'custom_records.manage': 'own' }, 11);

const NHA_KHOA = [
  { key: 'benh_nhan', label: 'Bệnh nhân', icon: 'stethoscope', fields: [
    { label: 'Họ tên', type: 'text', required: true }, { label: 'Ngày sinh', type: 'date' }, { label: 'SĐT', type: 'phone' },
    { label: 'Nhóm máu', type: 'select', choices: ['A', 'B', 'AB', 'O'] }, { label: 'Dị ứng', type: 'long_text' },
  ] },
  { key: 'lich_hen', label: 'Lịch hẹn', fields: [
    { label: 'Tiêu đề', type: 'text', required: true }, { label: 'Bệnh nhân', type: 'relation', target_object: 'benh_nhan' },
    { label: 'Giờ hẹn', type: 'datetime' }, { label: 'Phí', type: 'currency' }, { label: 'Đã đến', type: 'boolean' },
  ] },
];

function deps(existingKeys: string[] = [], over: Record<string, unknown> = {}) {
  const prisma = {
    customObject: {
      findMany: jest.fn().mockResolvedValue(existingKeys.map((key, i) => ({ id: i + 1, key }))),
      findFirst: jest.fn().mockImplementation(async ({ where }: { where: { key: string } }) => ({ id: 77, key: where.key, label: 'Bảng', label_plural: 'Bảng', is_active: true, deleted_at: null, visible_role_ids: [] })),
    },
    customView: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    customField: { findMany: jest.fn().mockResolvedValue([{ id: 1, object_id: 77, key: 'ho_ten', label: 'Họ tên', type: 'text', required: true, is_unique: false, is_title: true, show_in_list: true, sort_order: 10, options: {}, help_text: null }, { id: 2, object_id: 77, key: 'gia', label: 'Giá', type: 'number', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 20, options: {}, help_text: null }, { id: 3, object_id: 77, key: 'loai', label: 'Loại', type: 'select', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 30, options: { choices: [{ value: 'a', label: 'A' }] }, help_text: null }]) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    customRecord: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockResolvedValue([{ n: 0 }]),
  };
  return {
    prisma,
    objects: { create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}), remove: jest.fn().mockResolvedValue({}) },
    fields: { create: jest.fn().mockImplementation(async (_o: string, dto: { key: string }) => ({ key: dto.key })), update: jest.fn().mockResolvedValue({}), remove: jest.fn().mockResolvedValue({}) },
    templates: { apply: jest.fn().mockResolvedValue({ created: ['hoc_sinh'], existing: [], sample_records: 0 }), list: jest.fn().mockResolvedValue([{ key: 'education_center' }]) },
    ...over,
  } as never as ActionDeps & { prisma: typeof prisma; objects: { create: jest.Mock; remove: jest.Mock }; fields: { create: jest.Mock } };
}
const run = (name: string, args: Record<string, unknown>, d: ActionDeps, u: AuthUser = ADMIN) => actionToolByName(name)!.prepare(args, { deps: d, user: u } as ActionCtx);

describe('create_objects: dựng bộ bảng ngành trong MỘT lần duyệt', () => {
  it('Phòng khám nha khoa: chuẩn hoá, tóm tắt từng bảng, liên kết tới bảng cùng lô hợp lệ', async () => {
    const p = await run('create_objects', { confirmed_by_user: 'ok', objects: NHA_KHOA }, deps());
    const specs = (p.params as { objects: { key: string; label_plural: string; fields: { key: string }[] }[] }).objects;
    expect(specs.map((s) => s.key)).toEqual(['benh_nhan', 'lich_hen']);
    expect(specs[0].fields.map((f) => f.key)).toEqual(['ho_ten', 'ngay_sinh', 'sdt', 'nhom_mau', 'di_ung']);
    expect(specs[0].label_plural).toBe('Bệnh nhân');
    expect(p.summary).toContain('2 bảng');
    expect(JSON.stringify(p.details)).toContain('→ benh_nhan');
  });
  it('báo lỗi sớm: trùng khoá có sẵn, khoá hệ thống, kiểu lạ, liên kết tới bảng không có, thiếu trường tiêu đề, select thiếu lựa chọn, icon lạ', async () => {
    await expect(run('create_objects', { confirmed_by_user: 'ok', objects: NHA_KHOA }, deps(['benh_nhan']))).rejects.toThrow(/đã được dùng/);
    await expect(run('create_objects', { confirmed_by_user: 'ok', objects: [{ key: 'nav', label: 'X' }] }, deps())).rejects.toThrow(/từ khoá hệ thống/);
    await expect(run('create_objects', { confirmed_by_user: 'ok', objects: [{ label: 'X', fields: [{ label: 'A', type: 'lạ' }] }] }, deps())).rejects.toThrow(/Kiểu trường/);
    await expect(run('create_objects', { confirmed_by_user: 'ok', objects: [{ label: 'X', fields: [{ label: 'T', type: 'text' }, { label: 'K', type: 'relation', target_object: 'khong_co' }] }] }, deps())).rejects.toThrow(/liên kết/);
    await expect(run('create_objects', { confirmed_by_user: 'ok', objects: [{ label: 'X', fields: [{ label: 'Ghi chú', type: 'long_text' }] }] }, deps())).rejects.toThrow(/tiêu đề/);
    await expect(run('create_objects', { confirmed_by_user: 'ok', objects: [{ label: 'X', fields: [{ label: 'T', type: 'text' }, { label: 'S', type: 'select' }] }] }, deps())).rejects.toBeInstanceOf(ActionUserError);
    await expect(run('create_objects', { confirmed_by_user: 'ok', objects: [{ label: 'X', icon: 'rocket' }] }, deps())).rejects.toThrow(/Biểu tượng/);
    await expect(run('create_objects', { confirmed_by_user: 'ok', objects: [{ label: 'X', fields: [{ label: 'SĐT', type: 'phone', is_unique: true }] }] }, deps())).rejects.toBeInstanceOf(ActionUserError);
  });
  it('khoá tự sinh từ tên tiếng Việt có dấu; khoá trường trùng trong bảng bị từ chối', async () => {
    const p = await run('create_object', { confirmed_by_user: 'ok', label: 'Đơn hàng', fields: [{ label: 'Mã đơn', type: 'text' }] }, deps());
    expect((p.params as { objects: { key: string }[] }).objects[0].key).toBe('don_hang');
    await expect(run('create_object', { confirmed_by_user: 'ok', label: 'X', fields: [{ label: 'A', key: 'a', type: 'text' }, { label: 'B', key: 'a', type: 'number' }] }, deps())).rejects.toThrow(/trùng khoá/);
  });
  it('duyệt: tạo bảng trước rồi trường, relation phân giải ra id bảng đích; lỗi giữa chừng ⇒ lưu trữ lại bảng vừa tạo', async () => {
    const d = deps();
    const p = await run('create_objects', { confirmed_by_user: 'ok', objects: NHA_KHOA }, d);
    const r = await actionToolByName('create_objects')!.execute(p.params, { deps: d, user: ADMIN } as ActionCtx, 1);
    expect(r).toMatchObject({ created_objects: ['benh_nhan', 'lich_hen'] });
    expect(d.objects.create.mock.calls.map((c) => c[0].key)).toEqual(['benh_nhan', 'lich_hen']);
    expect(d.fields.create).toHaveBeenCalledTimes(10);
    const rel = d.fields.create.mock.calls.find((c) => c[1].type === 'relation');
    expect(rel[1].options).toMatchObject({ target_object_id: 77 });

    const bad = deps(); bad.fields.create.mockRejectedValueOnce(new Error('boom'));
    await expect(actionToolByName('create_objects')!.execute(p.params, { deps: bad, user: ADMIN } as ActionCtx, 2)).rejects.toThrow('boom');
    expect(bad.objects.remove.mock.calls.map((c) => c[0])).toEqual(['lich_hen', 'benh_nhan']);
  });
});

describe('update_object / add_field / update_field / archive_field / template', () => {
  it('update_object: ẩn bảng; không có gì đổi ⇒ lỗi; bảng không có ⇒ chỉ đường describe_schema', async () => {
    const p = await run('update_object', { object: 'benh_nhan', is_active: false }, deps());
    expect(p.summary).toContain('ẨN');
    await expect(run('update_object', { object: 'benh_nhan' }, deps())).rejects.toThrow(/Không có gì/);
    const d = deps(); (d.prisma.customObject.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(run('update_object', { object: 'x', label: 'Y' }, d)).rejects.toThrow(/describe_schema/);
  });
  it('add_field: select có lựa chọn, công thức tham chiếu trường có thật, khoá trùng bị từ chối; execute gọi service tạo trường', async () => {
    const d = deps();
    const ok = await run('add_field', { object: 'benh_nhan', label: 'Hạng thành viên', type: 'select', choices: ['Bạc', 'Vàng'] }, d);
    expect(ok.summary).toContain('Hạng thành viên');
    await run('add_field', { object: 'benh_nhan', label: 'Tổng', type: 'formula', expression: '{gia}*2' }, d);
    await expect(run('add_field', { object: 'benh_nhan', label: 'Tổng', type: 'formula', expression: '{khong_co}*2' }, d)).rejects.toBeInstanceOf(ActionUserError);
    await expect(run('add_field', { object: 'benh_nhan', label: 'Giá', type: 'number' }, d)).rejects.toThrow(/đã tồn tại/);
    await actionToolByName('add_field')!.execute(ok.params, { deps: d, user: ADMIN } as ActionCtx, 1);
    expect(d.fields.create).toHaveBeenCalledWith('benh_nhan', expect.objectContaining({ key: 'hang_thanh_vien', type: 'select' }), ADMIN);
  });
  it('update_field: đổi nhãn/lựa chọn; choices cho trường không phải select bị từ chối; không có trường ⇒ lỗi', async () => {
    const d = deps();
    const p = await run('update_field', { object: 'benh_nhan', field: 'loai', label: 'Phân loại', choices: ['A', 'B'] }, d);
    expect(p.params).toMatchObject({ field: 'loai', patch: { label: 'Phân loại', options: { choices: [{ label: 'A' }, { label: 'B' }] } } });
    await expect(run('update_field', { object: 'benh_nhan', field: 'gia', choices: ['x'] }, d)).rejects.toThrow(/select/);
    await expect(run('update_field', { object: 'benh_nhan', field: 'khong', label: 'x' }, d)).rejects.toThrow(/không có trường/);
    await actionToolByName('update_field')!.execute(p.params, { deps: d, user: ADMIN } as ActionCtx, 1);
    expect(d.fields.update).toHaveBeenCalled();
  });
  it('archive_field: ẩn được trường thường, không ẩn được trường tiêu đề', async () => {
    const d = deps();
    expect((await run('archive_field', { object: 'benh_nhan', field: 'gia' }, d)).summary).toContain('dữ liệu giữ nguyên');
    await expect(run('archive_field', { object: 'benh_nhan', field: 'ho_ten' }, d)).rejects.toThrow(/tiêu đề/);
  });
  it('install_object_template: mẫu lạ ⇒ liệt kê mẫu có; mẫu thật ⇒ nháp; execute gọi service áp mẫu', async () => {
    const d = deps();
    await expect(run('install_object_template', { template: 'khong_co' }, d)).rejects.toThrow(/Mẫu hiện có/);
    const p = await run('install_object_template', { template: 'education_center', confirmed_by_user: 'đồng ý' }, d);
    expect(p.summary).toContain('Cài mẫu');
    await actionToolByName('install_object_template')!.execute(p.params, { deps: d, user: ADMIN } as ActionCtx, 1);
    expect(d.templates.apply).toHaveBeenCalledWith(ADMIN, 'education_center', false);
  });
});

describe('phân quyền: chỉ admin sửa cấu trúc (qua McpServerService.execute)', () => {
  const principal = (u: AuthUser): McpPrincipal => ({ userId: u.userId, email: u.email, clientId: 'c', scopes: ['crm.read', 'crm.write'], tokenId: BigInt(1), user: u });
  const server = () => new McpServerService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { log: jest.fn().mockResolvedValue(undefined) } as never, { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const tools = ['create_objects', 'create_object', 'update_object', 'add_field', 'update_field', 'archive_field', 'list_object_templates', 'install_object_template'];
  it.each(tools)('%s: Sale và Trưởng nhóm bị từ chối vì thiếu custom_objects.manage', async (name) => {
    const tool = MCP_TOOLS.find((t) => t.name === name)!;
    for (const u of [SALE, LEAD]) {
      const r = await server().execute(tool, { object: 'x', objects: [{ label: 'X' }], label: 'X', template: 't', field: 'f', type: 'text' }, principal(u));
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('custom_objects.manage');
    }
  });
});
