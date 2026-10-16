import { BadRequestException } from '@nestjs/common';
import { listFeaturesTool, setFeaturesTool } from '../tools/feature-tools';
import { saveCrmOptionTool } from '../tools/options-tool';
import { ToolUserError } from '../tools/tool-types';

const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.example', principal: { userId: 7, user: { userId: 7 } } }) as never;

function fdeps(state: Record<string, boolean> = { dashboard: true, pos: false }) {
  return {
    orgFeatures: {
      get: jest.fn(async () => ({ ...state, locked: {} })),
      update: jest.fn(async (dto: Record<string, boolean>) => ({ ...state, ...dto })),
    },
  } as any;
}

describe('list_features', () => {
  it('nhóm theo Cơ bản / Kênh / Bán hàng / Nhân sự / Nâng cao, kèm bật-tắt', async () => {
    const r = (await listFeaturesTool.run({}, ctx(fdeps()))).structured as any;
    expect(r.data.groups.map((g: any) => g.group)).toEqual(['core', 'channels', 'sales', 'hr', 'advanced']);
    const all = r.data.groups.flatMap((g: any) => g.features);
    expect(all.find((f: any) => f.key === 'dashboard').enabled).toBe(true);
    expect(all.find((f: any) => f.key === 'pos').enabled).toBe(false);
    expect(r.data.basic).toContain('inbox');
  });
});

describe('set_features', () => {
  it('bật chạy ngay, không cần đồng ý', async () => {
    const d = fdeps();
    const r = (await setFeaturesTool.run({ enable: ['pos'] }, ctx(d))).structured as any;
    expect(d.orgFeatures.update).toHaveBeenCalledWith({ pos: true }, 7);
    expect(r.data.enabled).toEqual([{ key: 'pos', label: 'Bán hàng (POS)', enabled: true }]);
  });

  it('tắt cần lời đồng ý; có đồng ý thì tắt', async () => {
    const d = fdeps();
    await expect(setFeaturesTool.run({ disable: ['dashboard'] }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
    expect(d.orgFeatures.update).not.toHaveBeenCalled();
    await setFeaturesTool.run({ disable: ['dashboard'], confirmed_by_user: 'ok tắt đi' }, ctx(d));
    expect(d.orgFeatures.update).toHaveBeenCalledWith({ dashboard: false }, 7);
  });

  it('khoá lạ, trùng khoá, rỗng ⇒ báo lỗi, không ghi', async () => {
    const d = fdeps();
    await expect(setFeaturesTool.run({ enable: ['khong_co'] }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
    await expect(setFeaturesTool.run({ enable: ['pos'], disable: ['pos'], confirmed_by_user: 'ok' }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
    await expect(setFeaturesTool.run({}, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
    expect(d.orgFeatures.update).not.toHaveBeenCalled();
  });

  it('gói không có tính năng ⇒ lỗi người dùng đọc được', async () => {
    const d = fdeps();
    d.orgFeatures.update.mockRejectedValueOnce(new BadRequestException('Gói "Kết nối" không có tính năng này. Nâng gói để bật.'));
    await expect(setFeaturesTool.run({ enable: ['zalo_oa'] }, ctx(d))).rejects.toThrow('Nâng gói');
  });
});

function odeps(rows: any[] = []) {
  return {
    prisma: {
      settingOption: {
        findFirst: jest.fn(async ({ where }: any) => {
          if (where.id) return rows.find((r) => r.id === where.id && r.group_key === where.group_key) ?? null;
          if (where.label) return rows.find((r) => r.group_key === where.group_key && r.label.toLowerCase() === where.label.equals.toLowerCase()) ?? null;
          return rows.filter((r) => r.group_key === where.group_key).sort((a, b) => b.sort_order - a.sort_order)[0] ?? null;
        }),
        findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.group_key === where.group_key_value.group_key && r.value === where.group_key_value.value) ?? null),
        create: jest.fn(async ({ data }: any) => ({ id: 99, ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ ...rows.find((r) => r.id === where.id), ...data })),
      },
    },
  } as any;
}

describe('save_crm_option', () => {
  const src = [{ id: 1, group_key: 'contact_source', value: 'facebook', label: 'Facebook', sort_order: 2, is_active: true, is_system: true }];

  it('thêm mới: mã sinh từ nhãn, nối cuối danh sách', async () => {
    const d = odeps(src);
    const r = (await saveCrmOptionTool.run({ list: 'sources', label: 'Hội chợ Đà Nẵng' }, ctx(d))).structured as any;
    expect(d.prisma.settingOption.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ group_key: 'contact_source', value: 'hoi_cho_da_nang', label: 'Hội chợ Đà Nẵng', sort_order: 3, is_system: false }) }));
    expect(r.data.list).toBe('sources');
  });

  it('nhãn đã có ⇒ không thêm trùng', async () => {
    const d = odeps(src);
    await expect(saveCrmOptionTool.run({ list: 'sources', label: 'facebook' }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
    expect(d.prisma.settingOption.create).not.toHaveBeenCalled();
  });

  it('sửa theo id: tắt mục hệ thống được (ẩn, không xoá)', async () => {
    const d = odeps(src);
    await saveCrmOptionTool.run({ list: 'sources', id: 1, active: false }, ctx(d));
    expect(d.prisma.settingOption.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 }, data: expect.objectContaining({ is_active: false }) }));
  });

  it('id thuộc danh mục khác ⇒ lỗi', async () => {
    const d = odeps(src);
    await expect(saveCrmOptionTool.run({ list: 'stages', id: 1, label: 'X' }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
  });
});
