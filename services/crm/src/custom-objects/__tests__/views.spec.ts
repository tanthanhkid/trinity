import type { CustomObject } from '@prisma/client';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import type { ObjectDef } from '../custom-object-access';
import { CustomMenuService } from '../custom-menu.service';
import { CustomObjectsService } from '../custom-objects.service';
import { normalizeViewConfig } from '../view-config';

const user = (grants: Record<string, unknown>): AuthUser => ({ userId: 3, email: 'x@x.vn', isAdmin: false, grants: grants as Grants });
const DEF: ObjectDef = {
  obj: { id: 11, key: 'hoc_vien', label: 'Học viên' } as CustomObject,
  fields: [
    { id: 1, key: 'ho_ten', label: 'Họ tên', type: 'text', required: true, is_unique: false, is_title: true, show_in_list: true, sort_order: 10, options: {}, help_text: null },
    { id: 2, key: 'trang_thai', label: 'Trạng thái', type: 'select', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 20, options: { choices: [{ value: 'moi', label: 'Mới' }] }, help_text: null },
    { id: 3, key: 'hoc_phi', label: 'Học phí', type: 'currency', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 30, options: {}, help_text: null },
  ],
};

describe('normalizeViewConfig', () => {
  it('kanban: group_by phải là select; card_fields phải có thật', () => {
    expect(normalizeViewConfig(DEF, 'kanban', { group_by: 'trang_thai', card_fields: ['hoc_phi'] })).toEqual({ group_by: 'trang_thai', card_fields: ['hoc_phi'] });
    expect(() => normalizeViewConfig(DEF, 'kanban', { group_by: 'hoc_phi' })).toThrow(/lựa chọn/);
    expect(() => normalizeViewConfig(DEF, 'kanban', {})).toThrow(/group_by/);
    // khoá không tồn tại ⇒ câu riêng "cột không tồn tại", không lẫn với "phải là trường lựa chọn"
    expect(() => normalizeViewConfig(DEF, 'kanban', { group_by: 'khong_co' })).toThrow(/^group_by: cột không tồn tại: “khong_co”/);
    expect(() => normalizeViewConfig(DEF, 'kanban', { group_by: 'khong_co' })).not.toThrow(/lựa chọn/);
    expect(() => normalizeViewConfig(DEF, 'calendar', { date_field: 'khong_co' })).toThrow(/^date_field: cột không tồn tại/);
    expect(() => normalizeViewConfig(DEF, 'kanban', { group_by: 'trang_thai', card_fields: ['khong_co'] })).toThrow(/không có trường/);
  });
  it('list: cột + sắp xếp + lọc hợp lệ', () => {
    expect(normalizeViewConfig(DEF, 'list', { columns: ['ho_ten', 'hoc_phi'], sort: { field: 'hoc_phi', dir: 'desc' }, filter: { trang_thai: 'moi' } }))
      .toEqual({ columns: ['ho_ten', 'hoc_phi'], sort: { field: 'hoc_phi', dir: 'desc' }, filter: { trang_thai: 'moi' } });
    expect(() => normalizeViewConfig(DEF, 'list', { filter: { khong_co: 1 } })).toThrow();
  });
});

describe('CustomObjectsService.nav — menu gồm bảng + view, chung thứ tự', () => {
  it('view gắn menu của bảng người này thấy; view thu hẹp theo vai trò', async () => {
    const prisma = {
      userRole: { findMany: jest.fn().mockResolvedValue([{ role_id: 5 }]) },
      customObject: { findMany: jest.fn().mockResolvedValue([
        { id: 11, key: 'hoc_vien', label: 'Học viên', label_plural: 'Học viên', icon: 'users', nav_order: 2, show_in_nav: false, visible_role_ids: [], is_active: true, deleted_at: null },
        { id: 12, key: 'lop', label: 'Lớp', label_plural: 'Lớp', icon: null, nav_order: 3, show_in_nav: true, visible_role_ids: [], is_active: true, deleted_at: null },
      ]) },
      customView: { findMany: jest.fn().mockResolvedValue([
        { object_id: 11, key: 'pipeline', label: 'Pipeline', icon: null, nav_order: 1, visible_role_ids: [], deleted_at: null },
        { object_id: 11, key: 'bi_mat', label: 'Bí mật', icon: null, nav_order: 4, visible_role_ids: [99], deleted_at: null },
      ]) },
    };
    const nav = await new CustomObjectsService(prisma as never).nav(user({ 'custom_records.view': 'own' }));
    expect(nav.map((n) => [n.menu_key, n.href])).toEqual([['hoc_vien__pipeline', '/x/hoc_vien/v/pipeline'], ['lop', '/x/lop']]);
    expect(nav[0].icon).toBe('users');
  });
});

describe('CustomMenuService', () => {
  const prisma = () => {
    const tx = { customObject: { updateMany: jest.fn(), update: jest.fn() }, customView: { updateMany: jest.fn(), update: jest.fn() } };
    return {
      tx,
      customObject: { findMany: jest.fn().mockResolvedValue([{ id: 11, key: 'hoc_vien', label: 'Học viên' }, { id: 12, key: 'lop', label: 'Lớp' }]) },
      customView: { findMany: jest.fn().mockResolvedValue([{ id: 7, key: 'pipeline', object_id: 11, label: 'Pipeline' }]) },
      role: { findMany: jest.fn().mockResolvedValue([{ id: 2, name: 'Sale' }]) },
      $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
  };
  it('mục liệt kê hiện theo thứ tự; còn lại ẩn; vai trò theo tên', async () => {
    const p = prisma();
    await new CustomMenuService(p as never).apply([{ object: 'hoc_vien', view: 'pipeline', roles: ['sale'] }, { object: 'lop' }], user({}));
    expect(p.tx.customObject.updateMany).toHaveBeenCalledWith({ where: { deleted_at: null }, data: { show_in_nav: false } });
    expect(p.tx.customView.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { show_in_nav: true, nav_order: 1, visible_role_ids: [2] } });
    expect(p.tx.customObject.update).toHaveBeenCalledWith({ where: { id: 12 }, data: { show_in_nav: true, nav_order: 2 } });
  });
  it('bảng/view/vai trò lạ, mục lặp ⇒ 400, không ghi', async () => {
    const p = prisma();
    const svc = new CustomMenuService(p as never);
    await expect(svc.resolve([{ object: 'x' }])).rejects.toThrow(/Không có bảng/);
    await expect(svc.resolve([{ object: 'lop', view: 'kanban' }])).rejects.toThrow(/không có view/);
    await expect(svc.resolve([{ object: 'lop', roles: ['Giám đốc'] }])).rejects.toThrow(/Không có vai trò/);
    await expect(svc.resolve([{ object: 'lop' }, { object: 'lop' }])).rejects.toThrow(/lặp/);
    expect(p.$transaction).not.toHaveBeenCalled();
  });
});

describe('kiểu xem Lịch + Bảng', () => {
  const D: ObjectDef = {
    ...DEF,
    fields: [...DEF.fields, { id: 4, key: 'ngay_hen', label: 'Ngày hẹn', type: 'datetime', required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 40, options: {}, help_text: null }],
  };
  it('calendar: date_field phải là trường ngày/ngày giờ; mode mặc định tháng', () => {
    expect(normalizeViewConfig(D, 'calendar', { date_field: 'ngay_hen', card_fields: ['trang_thai'] })).toEqual({ date_field: 'ngay_hen', mode: 'month', card_fields: ['trang_thai'] });
    expect(normalizeViewConfig(D, 'calendar', { date_field: 'ngay_hen', mode: 'week' })).toMatchObject({ mode: 'week' });
    expect(() => normalizeViewConfig(D, 'calendar', {})).toThrow(/date_field/);
    expect(() => normalizeViewConfig(D, 'calendar', { date_field: 'hoc_phi' })).toThrow(/ngày/);
  });
  it('table: cột như danh sách', () => {
    expect(normalizeViewConfig(D, 'table', { columns: ['ho_ten', 'ngay_hen'] })).toEqual({ columns: ['ho_ten', 'ngay_hen'] });
    expect(() => normalizeViewConfig(D, 'table', { columns: ['khong_co'] })).toThrow(/không có trường/);
  });
});

describe('CustomViewsService.get — bộ lọc đã lưu có lựa chọn bị xoá', () => {
  it('view vẫn mở được, điều kiện hỏng bị bỏ (không 400)', async () => {
    const { CustomViewsService } = await import('../custom-views.service');
    const row = { id: 1, key: 'dang_hoc', object_id: 11, label: 'Đang học', type: 'list', config: { columns: ['ho_ten'], filter: { trang_thai: 'da_xoa', hoc_phi: { gte: 5 } } }, icon: null, show_in_nav: false, nav_order: 1, visible_role_ids: [], deleted_at: null };
    const prisma = {
      customObject: { findFirst: jest.fn().mockResolvedValue({ ...DEF.obj, deleted_at: null, visible_role_ids: [] }) },
      customField: { findMany: jest.fn().mockResolvedValue(DEF.fields) },
      customView: { findFirst: jest.fn().mockResolvedValue(row), findMany: jest.fn().mockResolvedValue([row]) },
    };
    jest.spyOn(await import('../custom-object-access'), 'loadVisibleObject').mockResolvedValue(DEF);
    jest.spyOn(await import('../custom-object-access'), 'loadObjectAccess').mockResolvedValue({ canManage: true, roleIds: [] } as never);
    const svc = new CustomViewsService(prisma as never);
    const v = await svc.get(user({}), 'hoc_vien', 'dang_hoc');
    expect(v.config.filter).toEqual({ hoc_phi: { gte: 5 } });
    expect((await svc.list(user({}), 'hoc_vien'))[0].config.filter).toEqual({ hoc_phi: { gte: 5 } });
  });
});
