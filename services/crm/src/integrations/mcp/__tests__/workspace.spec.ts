import { BadRequestException } from '@nestjs/common';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { CustomViewsService } from '../../../custom-objects/custom-views.service';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError, type ActionCtx, type ActionDeps } from '../actions/action-types';
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOLS } from '../mcp-tools.registry';

const ADMIN: AuthUser = { userId: 1, email: 'a@x.vn', isAdmin: false, grants: { 'custom_objects.manage': true, 'settings.features': true, 'custom_records.view': 'all', 'custom_records.manage': 'all', 'contacts.create': true } as unknown as Grants };

const GOI = {
  title: 'CRM trung tâm tiếng Anh',
  objects: [
    { key: 'hoc_vien', label: 'Học viên', icon: 'graduation-cap', fields: [
      { label: 'Họ tên', type: 'text', required: true }, { label: 'SĐT', type: 'phone' },
      { label: 'Trạng thái', key: 'trang_thai', type: 'select', choices: ['Mới', 'Đã tư vấn', 'Học thử', 'Đã đăng ký', 'Nghỉ'] },
      { label: 'Học phí', type: 'currency' },
    ] },
    { key: 'lop_hoc', label: 'Lớp học', fields: [{ label: 'Tên lớp', type: 'text' }, { label: 'Học viên', type: 'relation', target_object: 'hoc_vien', multiple: true }] },
  ],
  views: [{ object: 'hoc_vien', key: 'pipeline', label: 'Pipeline học viên', type: 'kanban', type_words: 'dạng kanban kéo thả', group_by: 'trang_thai', card_fields: ['hoc_phi'], show_in_nav: true }],
  features: ['kanban'],
  confirmed_by_user: 'ok tạo đi',
};

function deps(status: 'chua_dung' | 'dang_dung' | 'da_dung' = 'chua_dung', over: Partial<Record<string, unknown>> = {}) {
  const prisma = {
    customObject: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 2 }), update: jest.fn().mockResolvedValue({}) },
    customView: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), update: jest.fn().mockResolvedValue({}) },
    customField: { findMany: jest.fn().mockResolvedValue([]) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    role: { findMany: jest.fn().mockResolvedValue([{ name: 'Quản trị' }, { name: 'Bác sĩ' }]) },
    setting: { deleteMany: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    // Mã chung: gợi ý tiền tố (trinity_pick_code_prefix) + kiểm tiền tố đã có chủ.
    $queryRaw: jest.fn().mockImplementation(async (q: { sql: string }) => (q.sql.includes('trinity_pick_code_prefix') ? [{ p: 'HV' }] : [{ taken: false }])),
  };
  return {
    prisma,
    views: Object.assign(new CustomViewsService(prisma as never), { create: jest.fn().mockResolvedValue({ key: 'pipeline' }) }),
    menu: { resolve: jest.fn().mockResolvedValue([]), apply: jest.fn().mockResolvedValue({ shown: 2 }) },
    objects: { create: jest.fn().mockResolvedValue({}), remove: jest.fn().mockResolvedValue({}) },
    fields: { create: jest.fn().mockResolvedValue({}) },
    orgFeatures: { stored: jest.fn().mockResolvedValue(undefined), replaceAll: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    setup: { get: jest.fn().mockResolvedValue(status), set: jest.fn().mockResolvedValue(status) },
    ...over,
  } as never as ActionDeps & { prisma: typeof prisma; views: { create: jest.Mock }; menu: Record<'resolve' | 'apply', jest.Mock>; objects: Record<'create' | 'remove', jest.Mock>; fields: { create: jest.Mock }; orgFeatures: Record<'stored' | 'replaceAll' | 'update', jest.Mock>; setup: Record<'get' | 'set', jest.Mock> };
}
const ctx = (d: ActionDeps): ActionCtx => ({ deps: d, user: ADMIN });
const tool = (n: string) => actionToolByName(n)!;

describe('propose_workspace: một gói, duyệt một lần', () => {
  it('gói hợp lệ ⇒ tóm tắt bảng + kanban + menu + module; chưa ghi gì', async () => {
    const d = deps();
    const p = await tool('propose_workspace').prepare(GOI, ctx(d));
    expect(p.summary).toContain('2 bảng');
    expect(p.summary).toContain('1 màn xem');
    const txt = JSON.stringify(p.details);
    expect(txt).toContain('Mới → Đã tư vấn → Học thử');
    expect(txt).toContain('Kanban theo “trang_thai”');
    expect(txt).toContain('Module bật (còn lại TẮT)');
    expect(d.objects.create).not.toHaveBeenCalled();
  });
  it('báo lỗi sớm: kanban theo trường không phải select, view trỏ bảng lạ, module lạ, menu trỏ view lạ', async () => {
    const d = deps();
    await expect(tool('propose_workspace').prepare({ ...GOI, views: [{ object: 'hoc_vien', label: 'K', type: 'kanban', type_words: 'kanban', group_by: 'hoc_phi' }] }, ctx(d))).rejects.toBeInstanceOf(ActionUserError);
    await expect(tool('propose_workspace').prepare({ ...GOI, views: [{ object: 'khong_co', label: 'K', type: 'list', type_words: 'danh sách' }] }, ctx(d))).rejects.toThrow(/không có bảng/);
    await expect(tool('propose_workspace').prepare({ ...GOI, features: ['bay_lac'] }, ctx(d))).rejects.toThrow(/không có/);
    await expect(tool('propose_workspace').prepare({ ...GOI, menu: [{ object: 'hoc_vien', view: 'lich' }] }, ctx(d))).rejects.toThrow(/không có view/);
  });
  it('vai trò trong menu kiểm NGAY lúc đề xuất (vai "Lễ tân" không có) — trả danh sách vai có thật', async () => {
    const d = deps();
    const err = tool('propose_workspace').prepare({ ...GOI, menu: [{ object: 'hoc_vien', view: 'pipeline', roles: ['Lễ tân', 'bác sĩ'] }] }, ctx(d));
    await expect(err).rejects.toBeInstanceOf(ActionUserError);
    await expect(err).rejects.toThrow(/không có vai trò “Lễ tân”\. Vai trò hiện có: Quản trị, Bác sĩ/);
    // Tên có thật (không phân biệt hoa thường) ⇒ qua.
    await expect(tool('propose_workspace').prepare({ ...GOI, menu: [{ object: 'hoc_vien', view: 'pipeline', roles: ['bác sĩ'] }] }, ctx(d))).resolves.toBeTruthy();
  });
  it('duyệt (hệ thống trống): tạo bảng → trường → view → menu → module (ghi ĐỦ khoá) → dang_dung', async () => {
    const d = deps();
    d.prisma.customObject.findFirst.mockImplementation(async ({ where }: { where: { key: string } }) => ({ id: where.key === 'hoc_vien' ? 11 : 12, key: where.key, label: where.key, label_plural: where.key, is_active: true, deleted_at: null, visible_role_ids: [] }));
    const p = await tool('propose_workspace').prepare(GOI, ctx(d));
    const r = await tool('propose_workspace').execute(p.params, ctx(d), 1);
    expect(d.objects.create.mock.calls.map((c: { key: string }[]) => c[0].key)).toEqual(['hoc_vien', 'lop_hoc']);
    expect(d.fields.create).toHaveBeenCalledTimes(6);
    expect(d.views.create).toHaveBeenCalledTimes(1);
    expect(d.menu.apply.mock.calls[0][0]).toEqual([{ object: 'hoc_vien', view: 'pipeline' }, { object: 'lop_hoc' }]);
    expect(d.orgFeatures.replaceAll).toHaveBeenCalledWith(expect.arrayContaining(['kanban', 'integrations']), 1);
    expect(d.setup.set).toHaveBeenCalledWith('dang_dung', 1);
    expect(r).toMatchObject({ setup_status: 'dang_dung', open_at: '/x/hoc_vien/v/pipeline' });
  });
  it('hệ thống ĐANG DÙNG: chỉ BẬT thêm module, không tắt module khác, không đổi trạng thái', async () => {
    const d = deps('da_dung');
    d.prisma.customObject.findFirst.mockResolvedValue({ id: 11, key: 'hoc_vien', label: 'x', label_plural: 'x', is_active: true, deleted_at: null, visible_role_ids: [] });
    const p = await tool('propose_workspace').prepare(GOI, ctx(d));
    await tool('propose_workspace').execute(p.params, ctx(d), 1);
    expect(d.orgFeatures.replaceAll).not.toHaveBeenCalled();
    expect(d.orgFeatures.update).toHaveBeenCalledWith({ kanban: true }, 1);
    expect(d.setup.set).not.toHaveBeenCalled();
  });
  it('lỗi giữa chừng ⇒ không dựng nửa vời: xoá hẳn bảng của gói, trả trạng thái cũ, ném lỗi', async () => {
    const d = deps();
    d.prisma.customObject.findFirst.mockResolvedValue({ id: 11, key: 'hoc_vien', label: 'x', label_plural: 'x', is_active: true, deleted_at: null, visible_role_ids: [] });
    d.menu.apply.mockRejectedValue(new Error('boom'));
    const p = await tool('propose_workspace').prepare(GOI, ctx(d));
    await expect(tool('propose_workspace').execute(p.params, ctx(d), 1)).rejects.toThrow('boom');
    expect(d.prisma.customObject.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ key: { in: ['hoc_vien', 'lop_hoc'] }, created_by: 1 }) });
    expect(d.prisma.setting.deleteMany).toHaveBeenCalledWith({ where: { key: 'org_features' } });
    expect(d.setup.set).toHaveBeenLastCalledWith('chua_dung', 1);
  });
});

describe('import_records: lô ≤500 dòng, xem trước, duyệt mới ghi', () => {
  const DEF = { id: 11, key: 'hoc_vien', label: 'Học viên', label_plural: 'Học viên', is_active: true, deleted_at: null, visible_role_ids: [] };
  const FIELDS = [
    { id: 1, object_id: 11, key: 'ho_ten', label: 'Họ tên', type: 'text', required: true, is_unique: false, is_title: true, show_in_list: true, sort_order: 10, options: {}, help_text: null },
    { id: 2, object_id: 11, key: 'sdt', label: 'SĐT', type: 'phone', required: false, is_unique: true, is_title: false, show_in_list: true, sort_order: 20, options: {}, help_text: null },
  ];
  const importDeps = () => {
    const d = deps('dang_dung');
    d.prisma.customObject.findFirst.mockResolvedValue(DEF);
    d.prisma.customField.findMany.mockResolvedValue(FIELDS);
    const validator = {
      validate: jest.fn().mockImplementation(async (_def: unknown, _u: unknown, row: Record<string, unknown>) => {
        if (!row.ho_ten) throw new BadRequestException({ message: 'Dữ liệu không hợp lệ', errors: { ho_ten: '“Họ tên” là bắt buộc' } });
        return { data: row, changed: Object.keys(row) };
      }),
      assertUnique: jest.fn().mockResolvedValue(undefined),
    };
    return Object.assign(d, { validator }) as typeof d & { validator: typeof validator };
  };
  it('xem trước: đếm dòng hợp lệ/lỗi, cột ghép, SĐT bị che; params chỉ giữ dòng hợp lệ', async () => {
    const d = importDeps();
    const rows = [{ ho_ten: 'An', sdt: '0901234567' }, { ho_ten: 'Bình', sdt: '0900000002' }, { sdt: '0911111111' }, { ho_ten: 'Chi', sdt: '0901234567' }];
    const p = await tool('import_records').prepare({ object: 'hoc_vien', rows, mapping: { 'Tên HV': 'ho_ten', 'Điện thoại': 'sdt' }, source: 'Sheet Học viên 2026' }, ctx(d));
    expect((p.params.rows as unknown[]).length).toBe(2);
    const txt = JSON.stringify(p.details);
    expect(txt).toContain('4 dòng gửi lên — 2 hợp lệ sẽ ghi, 2 dòng lỗi');
    expect(txt).toContain('Tên HV → ho_ten');
    expect(txt).toContain('Dòng 3: ho_ten');
    expect(txt).toContain('Dòng 4: “SĐT” trùng với dòng khác trong lô');
    expect(txt).not.toContain('0901234567');
  });
  it('quá 500 dòng / không dòng nào hợp lệ ⇒ lỗi AI sửa được', async () => {
    const d = importDeps();
    await expect(tool('import_records').prepare({ object: 'hoc_vien', rows: Array.from({ length: 501 }, () => ({ ho_ten: 'x' })) }, ctx(d))).rejects.toThrow(/tối đa 500/);
    await expect(tool('import_records').prepare({ object: 'hoc_vien', rows: [{ sdt: '1' }] }, ctx(d))).rejects.toThrow(/Không có dòng nào hợp lệ/);
  });
  it('duyệt: kiểm lại theo cấu trúc hiện tại rồi ghi cả lô trong MỘT giao dịch', async () => {
    const d = importDeps();
    const createMany = jest.fn().mockResolvedValue([{ id: 51, code: 'HV001' }, { id: 52, code: 'HV002' }]);
    const sync = jest.fn().mockResolvedValue(undefined);
    Object.assign(d, { links: { targetsFor: jest.fn().mockResolvedValue(new Map()), sync } });
    Object.assign(d.prisma, { $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ $executeRaw: jest.fn(), customRecord: { createManyAndReturn: createMany } })) });
    const r = await tool('import_records').execute({ object: 'hoc_vien', rows: [{ ho_ten: 'An' }, { ho_ten: 'Bình' }] }, ctx(d), 9);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[0][1]).toEqual({ type: 'record', id: 51 });
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ object_id: 11, title: 'An', owner_id: 1, created_by: 1 });
    expect(r).toMatchObject({ created: 2, codes: 'HV001, HV002' });
  });
  it('dòng lỗi lúc kiểm đi tới kết quả: errors [{row, reason}] + error_total (bảng tuỳ biến)', async () => {
    const d = importDeps();
    const rows = [{ ho_ten: 'An' }, { sdt: '0911111111' }, { ho_ten: 'Bình' }, { sdt: '0922222222' }];
    const p = await tool('import_records').prepare({ object: 'hoc_vien', rows }, ctx(d));
    expect(p.params).toMatchObject({ row_numbers: [1, 3], error_total: 2 });
    expect((p.params.errors as { row: number; reason: string }[]).map((e) => e.row)).toEqual([2, 4]);
    const createMany = jest.fn().mockResolvedValue([{ id: 51, code: 'HV001' }, { id: 52, code: 'HV002' }]);
    Object.assign(d, { links: { targetsFor: jest.fn().mockResolvedValue(new Map()), sync: jest.fn() } });
    Object.assign(d.prisma, { $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ $executeRaw: jest.fn(), customRecord: { createManyAndReturn: createMany } })) });
    const r = await tool('import_records').execute(p.params, ctx(d), 9);
    expect(r).toMatchObject({ created: 2, skipped: 2, error_total: 2 });
    expect(r.errors).toEqual([{ row: 2, reason: 'ho_ten: “Họ tên” là bắt buộc' }, { row: 4, reason: 'ho_ten: “Họ tên” là bắt buộc' }]);
  });
  it('quá 50 dòng lỗi ⇒ chỉ trả 50 dòng đầu, error_total là tổng thật', async () => {
    const d = importDeps();
    const rows = [{ ho_ten: 'An' }, ...Array.from({ length: 60 }, () => ({ sdt: '1' }))];
    const p = await tool('import_records').prepare({ object: 'hoc_vien', rows }, ctx(d));
    expect((p.params.errors as unknown[]).length).toBe(50);
    expect(p.params.error_total).toBe(60);
  });
  it('contacts: lỗi lúc ghi trỏ đúng số dòng gốc, gộp với lỗi lúc kiểm', async () => {
    const create = jest.fn().mockResolvedValueOnce({ id: 1 }).mockRejectedValueOnce(new Error('SĐT đã có'));
    const d = Object.assign(importDeps(), { contacts: { create } });
    const params = { object: 'contacts', rows: [{ full_name: 'A', phone: '0901234567', source_id: 1 }, { full_name: 'B', phone: '0901234568', source_id: 1 }], row_numbers: [2, 5], errors: [{ row: 1, reason: 'Thiếu phone' }], error_total: 1 };
    const r = await tool('import_records').execute(params, ctx(d), 9);
    expect(r).toMatchObject({ created: 1, failed: 1, skipped: 1, error_total: 2 });
    expect(r.errors).toEqual([{ row: 1, reason: 'Thiếu phone' }, { row: 5, reason: 'SĐT đã có' }]);
  });
});

describe('view + menu', () => {
  const DEF = { id: 11, key: 'hoc_vien', label: 'Học viên', label_plural: 'Học viên', is_active: true, deleted_at: null, visible_role_ids: [] };
  const FIELDS = [
    { id: 1, object_id: 11, key: 'ho_ten', label: 'Họ tên', type: 'text', required: true, is_unique: false, is_title: true, show_in_list: true, sort_order: 10, options: {}, help_text: null },
    { id: 2, object_id: 11, key: 'trang_thai', label: 'Trạng thái', type: 'select', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 20, options: { choices: [{ value: 'moi', label: 'Mới' }] }, help_text: null },
  ];
  it('create_view kanban hợp lệ / sai trường chia cột', async () => {
    const d = deps('da_dung');
    d.prisma.customObject.findFirst.mockResolvedValue(DEF);
    d.prisma.customField.findMany.mockResolvedValue(FIELDS);
    const p = await tool('create_view').prepare({ object: 'hoc_vien', label: 'Pipeline', type: 'kanban', type_words: 'kéo thả theo trạng thái', group_by: 'trang_thai', show_in_nav: true }, ctx(d));
    expect(p.summary).toContain('Kanban theo “trang_thai”');
    await expect(tool('create_view').prepare({ object: 'hoc_vien', label: 'K', type: 'kanban', type_words: 'kanban', group_by: 'ho_ten' }, ctx(d))).rejects.toThrow(/chỉ chia cột theo trường “lựa chọn”/);
    await expect(tool('create_view').prepare({ object: 'hoc_vien', label: 'L', type: 'gantt' }, ctx(d))).rejects.toThrow(/chưa được Trinity hỗ trợ/);
    // lịch đã nhận, nhưng cần date_field là trường ngày/giờ.
    await expect(tool('create_view').prepare({ object: 'hoc_vien', label: 'L', type: 'calendar', type_words: 'dạng lịch' }, ctx(d))).rejects.toThrow(/date_field/);
  });
  it('update_view đổi tên ⇒ summary "cũ → mới"', async () => {
    const d = deps('da_dung');
    d.prisma.customObject.findFirst.mockResolvedValue(DEF);
    d.prisma.customField.findMany.mockResolvedValue(FIELDS);
    Object.assign(d.prisma.customView, { findFirst: jest.fn().mockResolvedValue({ key: 'ds', label: 'Danh sách', type: 'table', config: {}, icon: null, show_in_nav: true }) });
    Object.assign(d.views, { check: jest.fn().mockResolvedValue(undefined) });
    const p = await tool('update_view').prepare({ object: 'hoc_vien', view: 'ds', label: 'Tất cả học viên' }, ctx(d));
    expect(p.summary).toContain('Sửa màn “Danh sách → Tất cả học viên”');
  });
  it('set_menu: tóm tắt theo thứ tự; lỗi mục lạ trả lời AI sửa được', async () => {
    const d = deps('da_dung');
    d.menu.resolve.mockResolvedValue([{ label: 'Pipeline', rolesGiven: false }, { label: 'Lớp học', rolesGiven: true }]);
    const p = await tool('set_menu').prepare({ menu: [{ object: 'hoc_vien', view: 'pipeline' }, { object: 'lop_hoc', roles: ['Quản trị'] }] }, ctx(d));
    expect(p.summary).toContain('Pipeline · Lớp học');
    d.menu.resolve.mockRejectedValue(new BadRequestException('Không có bảng “x”.'));
    await expect(tool('set_menu').prepare({ menu: [{ object: 'x' }] }, ctx(d))).rejects.toBeInstanceOf(ActionUserError);
  });
});

describe('get_setup_guide / complete_setup + server instructions', () => {
  const t = (n: string) => MCP_TOOLS.find((x) => x.name === n)!;
  const principal = { userId: 1, email: 'a', clientId: 'c', scopes: ['crm.read', 'crm.write'], tokenId: BigInt(1), user: ADMIN };
  it('instructions bảo AI bắt đầu bằng get_setup_guide và chủ động phỏng vấn', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain('get_setup_guide');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('propose_workspace');
  });
  it('get_setup_guide có agent ⇒ connect_prompt đầy đủ (không bị cắt), đúng địa chỉ máy chủ', async () => {
    const old = process.env.INTEGRATIONS_PUBLIC_BASE_URL;
    process.env.INTEGRATIONS_PUBLIC_BASE_URL = 'https://crm.example.com';
    try {
      const d = { setup: { get: jest.fn().mockResolvedValue('chua_dung') }, orgFeatures: { get: jest.fn().mockResolvedValue({ integrations: true }) }, prisma: { customObject: { findMany: jest.fn().mockResolvedValue([]) }, customView: { count: jest.fn().mockResolvedValue(0) }, role: { findMany: jest.fn().mockResolvedValue([]) }, userRole: { findMany: jest.fn().mockResolvedValue([]) } } };
      const r = await t('get_setup_guide').run({ agent: 'antigravity' }, { deps: d as never, principal: principal as never, baseUrl: 'https://x' });
      const p = (r.structured as { data: { connect_prompt: string } }).data.connect_prompt;
      expect(p.length).toBeGreaterThan(1500);
      expect(p).not.toContain('[đã cắt]');
      expect(p).toContain('"serverUrl": "https://crm.example.com/api/v1/mcp"');
      const none = await t('get_setup_guide').run({}, { deps: d as never, principal: principal as never, baseUrl: 'https://x' });
      expect((none.structured as { data: Record<string, unknown> }).data.connect_prompt).toBeUndefined();
    } finally {
      if (old === undefined) delete process.env.INTEGRATIONS_PUBLIC_BASE_URL; else process.env.INTEGRATIONS_PUBLIC_BASE_URL = old;
    }
  });

  it('get_setup_guide: trạng thái + kịch bản phỏng vấn tiếng Việt (xin Sheet/Excel)', async () => {
    const d = { setup: { get: jest.fn().mockResolvedValue('chua_dung') }, orgFeatures: { get: jest.fn().mockResolvedValue({ integrations: true }) }, prisma: { customObject: { findMany: jest.fn().mockResolvedValue([{ key: 'benh_nhan', label_plural: 'Bệnh nhân', code_prefix: 'BN' }]) }, customView: { count: jest.fn().mockResolvedValue(0) }, role: { findMany: jest.fn().mockResolvedValue([{ name: 'Quản trị' }, { name: 'Bác sĩ' }]) }, userRole: { findMany: jest.fn().mockResolvedValue([]) } } };
    const r = await t('get_setup_guide').run({}, { deps: d as never, principal: principal as never, baseUrl: 'https://x' });
    const txt = JSON.stringify(r.structured);
    expect(txt).toContain('chua_dung');
    // Tra vai trò trước + mã chung của từng bảng.
    expect((r.structured as { data: { current: { roles: string[]; tables: string[] } } }).data.current).toMatchObject({ roles: ['Quản trị', 'Bác sĩ'], tables: ['Bệnh nhân [benh_nhan] mã BN001...'] });
    expect(txt).toContain('TRA VAI TRÒ TRƯỚC');
    expect(txt).toContain('MÃ CHUNG');
    expect(txt).toContain('Google Sheet');
    expect(txt).toContain('propose_workspace');
  });
  it('get_setup_guide: người không quản trị không thấy bảng ẩn theo vai trò và không thấy tên vai trò', async () => {
    const d = {
      setup: { get: jest.fn().mockResolvedValue('da_dung') },
      orgFeatures: { get: jest.fn().mockResolvedValue({}) },
      prisma: {
        customObject: { findMany: jest.fn().mockResolvedValue([
          { key: 'cong_khai', label_plural: 'Công khai', code_prefix: 'CK', is_active: true, deleted_at: null, visible_role_ids: [] },
          { key: 'luong', label_plural: 'Lương', code_prefix: 'L', is_active: true, deleted_at: null, visible_role_ids: [99] },
          { key: 'tat', label_plural: 'Đã tắt', code_prefix: null, is_active: false, deleted_at: null, visible_role_ids: [] },
        ]) },
        customView: { count: jest.fn().mockResolvedValue(0) },
        role: { findMany: jest.fn().mockResolvedValue([{ name: 'Quản trị' }]) },
        userRole: { findMany: jest.fn().mockResolvedValue([{ role_id: 5 }]) },
      },
    };
    const sale = { ...principal, user: { userId: 2, isAdmin: false, grants: { 'custom_records.view': 'own' } } };
    const r = await t('get_setup_guide').run({}, { deps: d as never, principal: sale as never, baseUrl: 'https://x' });
    const cur = (r.structured as { data: { current: { roles: string[]; tables: string[] } } }).data.current;
    expect(cur.tables).toHaveLength(1);
    expect(cur.tables[0]).toContain('cong_khai');
    expect(cur.roles).toEqual([]);
    expect(JSON.stringify(r.structured)).not.toContain('luong');
    const noView = { ...principal, user: { userId: 3, isAdmin: false, grants: {} } };
    const r2 = await t('get_setup_guide').run({}, { deps: d as never, principal: noView as never, baseUrl: 'https://x' });
    expect((r2.structured as { data: { current: { tables: string[] } } }).data.current.tables).toEqual([]);
  });
  it('complete_setup: chua_dung ⇒ từ chối; dang_dung ⇒ da_dung', async () => {
    const set = jest.fn();
    await expect(t('complete_setup').run({}, { deps: { setup: { get: jest.fn().mockResolvedValue('chua_dung'), set } } as never, principal: principal as never, baseUrl: '' })).rejects.toThrow(/Chưa dựng/);
    await t('complete_setup').run({}, { deps: { setup: { get: jest.fn().mockResolvedValue('dang_dung'), set } } as never, principal: principal as never, baseUrl: '' });
    expect(set).toHaveBeenCalledWith('da_dung', 1);
    expect(t('complete_setup').scope).toBe('crm.write');
    expect(t('complete_setup').permissions).toEqual(['custom_objects.manage']);
  });
});

describe('message của tool ghi nêu dòng lỗi', () => {
  it('import_records trả errors ⇒ message có "N dòng lỗi" và vài dòng đầu', async () => {
    const t = MCP_TOOLS.find((x) => x.name === 'import_records')!;
    const actions = {
      requiresApproval: jest.fn().mockResolvedValue(false),
      executeNow: jest.fn().mockResolvedValue({ id: 7, status: 'executed', summary: 'Nhập 2 Học viên (bỏ 2 dòng lỗi) từ X', result: { created: 2, errors: [{ row: 2, reason: 'Trường không tồn tại: foo' }, { row: 4, reason: 'thiếu ho_ten' }], error_total: 2 } }),
    };
    const out = await t.run({ object: 'hoc_vien', rows: [{}] }, { deps: { actions } as never, principal: {} as never, baseUrl: 'https://x' });
    const msg = (out.structured.data as { message: string }).message;
    expect(msg).toContain('2 dòng lỗi không ghi: dòng 2: Trường không tồn tại: foo; dòng 4: thiếu ho_ten');
  });
});
