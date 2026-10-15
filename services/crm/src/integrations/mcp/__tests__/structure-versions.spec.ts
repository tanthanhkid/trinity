import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { SchemaVersionsService, type StructureSnapshot } from '../../../custom-objects/schema-versions.service';
import { actionToolByName } from '../actions/action-registry';
import type { ActionCtx, ActionDeps } from '../actions/action-types';
import { AiActionsService } from '../actions/ai-actions.service';

const ADMIN: AuthUser = { userId: 1, email: 'a@x.vn', isAdmin: false, grants: { 'custom_objects.manage': true, 'settings.features': true } as unknown as Grants };
const OBJ = { id: 11, key: 'hoc_vien', label: 'Học viên', label_plural: 'Học viên', is_active: true, deleted_at: null, visible_role_ids: [] };
const F = (id: number, key: string, label: string, type: string, extra: Record<string, unknown> = {}) => ({ id, object_id: 11, key, label, type, required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: id * 10, options: {}, help_text: null, ...extra });
const FIELDS = [F(1, 'ho_ten', 'Họ tên', 'text', { is_title: true }), F(2, 'nguon', 'Nguồn', 'select', { options: { choices: [{ value: 'fb', label: 'Facebook' }, { value: 'gt', label: 'Giới thiệu' }] } })];

function deps(withValue: number, usingDropped = withValue) {
  return {
    prisma: {
      customObject: { findFirst: jest.fn().mockResolvedValue(OBJ), findMany: jest.fn().mockResolvedValue([]) },
      customField: { findMany: jest.fn().mockResolvedValue(FIELDS) },
      userRole: { findMany: jest.fn().mockResolvedValue([]) },
      customRecord: { count: jest.fn().mockResolvedValue(withValue + 3) },
      // Đếm bản ghi DÙNG lựa chọn bị bỏ (ANY(values)) khác đếm bản ghi CÓ dữ liệu ở trường.
      $queryRaw: jest.fn().mockImplementation(async (q: { sql: string }) => [{ n: q.sql.includes('ANY(') || q.sql.includes('?|') ? usingDropped : withValue }]),
    },
  } as never as ActionDeps;
}
const ctx = (d: ActionDeps): ActionCtx => ({ deps: d, user: ADMIN });

describe(' ảnh hưởng đổi cấu trúc', () => {
  it('archive_field có dữ liệu ⇒ số bản ghi + phải gõ tên bảng', async () => {
    const p = await actionToolByName('archive_field')!.prepare({ object: 'hoc_vien', field: 'nguon' }, ctx(deps(42)));
    expect(p.impact).toMatchObject({ affected_records: 42, confirm_label: 'Học viên' });
    expect(p.impact!.lines[0]).toContain('42 bản ghi');
  });
  it('archive_field chưa có dữ liệu ⇒ không bắt gõ tên', async () => {
    const p = await actionToolByName('archive_field')!.prepare({ object: 'hoc_vien', field: 'nguon' }, ctx(deps(0)));
    expect(p.impact!.confirm_label).toBeNull();
  });
  it('update_field: đổi nhãn = 0 ảnh hưởng; bỏ lựa chọn = báo lựa chọn bị bỏ + số bản ghi', async () => {
    const rename = await actionToolByName('update_field')!.prepare({ object: 'hoc_vien', field: 'nguon', label: 'Kênh' }, ctx(deps(10)));
    expect(rename.impact!.affected_records).toBe(0);
    // 50 bản ghi có dữ liệu ở trường, chỉ 6 dùng lựa chọn bị bỏ ⇒ báo 6 (không phải 50).
    const d = deps(50, 6);
    const drop = await actionToolByName('update_field')!.prepare({ object: 'hoc_vien', field: 'nguon', choices: [{ label: 'Facebook', value: 'fb' }] }, ctx(d));
    expect(drop.impact).toMatchObject({ affected_records: 6, confirm_label: 'Học viên' });
    expect(drop.impact!.lines.join(' ')).toContain('6 bản ghi của “Học viên” đang dùng lựa chọn bị bỏ: Giới thiệu');
    const usage = (d as unknown as { prisma: { $queryRaw: jest.Mock } }).prisma.$queryRaw.mock.calls.map((c) => c[0]).find((q: { sql: string }) => q.sql.includes('ANY('));
    expect(usage.values).toEqual(expect.arrayContaining([['gt']]));
    // Chỉ đổi tên / thứ tự lựa chọn ⇒ 0, không bắt gõ tên bảng.
    const relabel = await actionToolByName('update_field')!.prepare({ object: 'hoc_vien', field: 'nguon', choices: [{ label: 'Giới thiệu bạn bè', value: 'gt' }, { label: 'Facebook', value: 'fb' }] }, ctx(deps(50, 0)));
    expect(relabel.impact).toMatchObject({ affected_records: 0, confirm_label: null });
  });
  it('update_object ẩn bảng ⇒ đếm mọi bản ghi của bảng', async () => {
    const p = await actionToolByName('update_object')!.prepare({ object: 'hoc_vien', is_active: false }, ctx(deps(5)));
    expect(p.impact).toMatchObject({ affected_records: 8, confirm_label: 'Học viên' });
  });
});

describe(' duyệt: gõ tên bảng + lưu phiên bản TRƯỚC khi đổi', () => {
  const draft = (impact: unknown) => ({ id: 5, user_id: 1, client_id: 'c', tool: 'archive_field', params: { object: 'hoc_vien', field: 'nguon' }, summary: 'Ẩn trường', details: [], status: 'pending', result: null, error: null, impact, created_at: new Date(), decided_at: null, expires_at: new Date(Date.now() + 60_000) });
  function svc(impact: unknown) {
    const row = draft(impact);
    const prisma = {
      aiActionDraft: { findFirst: jest.fn().mockResolvedValue(row), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue(row) },
      oauthClient: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const versions = { save: jest.fn().mockResolvedValue(9) };
    const fields = { remove: jest.fn().mockResolvedValue({ ok: true }) };
    const s = new AiActionsService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { log: jest.fn().mockResolvedValue(undefined) } as never, {} as never, {} as never, {} as never, {} as never, {} as never, fields as never, {} as never, {} as never, {} as never, {} as never, {} as never, versions as never, {} as never, {} as never);
    return { s, prisma, versions, fields };
  }
  it('thiếu / sai tên bảng ⇒ 400, KHÔNG nhận duyệt, không đổi gì', async () => {
    const { s, prisma, fields } = svc({ confirm_label: 'Học viên', affected_records: 42 });
    await expect(s.approve(ADMIN, 5)).rejects.toThrow(/gõ đúng tên bảng “Học viên”/);
    await expect(s.approve(ADMIN, 5, 'hoc vien')).rejects.toThrow(/gõ đúng/);
    expect(prisma.aiActionDraft.updateMany).not.toHaveBeenCalled();
    expect(fields.remove).not.toHaveBeenCalled();
  });
  it('gõ đúng (không phân biệt hoa/thường, khoảng trắng) ⇒ lưu phiên bản rồi mới chạy', async () => {
    const { s, versions, fields } = svc({ confirm_label: 'Học viên', affected_records: 42 });
    await s.approve(ADMIN, 5, '  học   VIÊN ');
    expect(versions.save).toHaveBeenCalledWith(5, 'archive_field', 'Ẩn trường', 1);
    expect(versions.save.mock.invocationCallOrder[0]).toBeLessThan(fields.remove.mock.invocationCallOrder[0]);
  });
});

describe('SchemaVersionsService.diff — quay lui báo bảng ảnh hưởng', () => {
  it('trường thêm sau phiên bản bị ẩn; trường đã ẩn hiện lại; bảng mới bị ẩn — kèm số bản ghi', async () => {
    const target: StructureSnapshot = { objects: [OBJ as never], fields: [FIELDS[0] as never, F(3, 'ghi_chu', 'Ghi chú', 'long_text') as never], views: [], features: null };
    const prisma = {
      customObject: { findMany: jest.fn().mockResolvedValue([OBJ, { ...OBJ, id: 12, key: 'lop', label: 'Lớp' }]) },
      customField: { findMany: jest.fn().mockResolvedValue(FIELDS) },
      customView: { findMany: jest.fn().mockResolvedValue([]) },
      setting: { findUnique: jest.fn().mockResolvedValue(null) },
      customRecord: { groupBy: jest.fn().mockResolvedValue([{ object_id: 11, _count: { _all: 30 } }, { object_id: 12, _count: { _all: 4 } }]) },
    };
    const d = await new SchemaVersionsService(prisma as never).diff(target);
    expect(d.affected_records).toBe(34);
    expect(d.tables.find((t) => t.key === 'lop')?.change).toContain('ẨN');
    const hv = d.tables.find((t) => t.key === 'hoc_vien')!;
    expect(hv.change).toContain('ẩn Nguồn');
    expect(hv.change).toContain('hiện lại Ghi chú');
  });
});
