import { setupBuildTool } from '../tools/setup-tools';

const ctx = (setupBuild?: unknown) => ({ deps: { setupBuild }, principal: { user: { userId: 1, grants: {} }, userId: 1 } }) as never;

describe('tool setup_build', () => {
  it('cần quyền quản lý tính năng tuỳ biến + tính năng công ty, có scope ghi', () => {
    expect(setupBuildTool.permissions).toEqual(['custom_objects.manage', 'settings.features']);
    expect(setupBuildTool.scope).toBe('crm.write');
  });

  it('gọi đúng service dựng với ngành + phân hệ, trả kết quả gọn', async () => {
    const build = jest.fn().mockResolvedValue({ industry: 'clinic', features: ['dashboard'], created_objects: ['pk_benh_nhan'], existing_objects: [], sample_records: 3, sample_contacts: 0, setup_status: 'da_dung' });
    const r = await setupBuildTool.run({ industry: 'clinic', features: ['pos'] }, ctx({ build }));
    expect(build).toHaveBeenCalledWith({ userId: 1, grants: {} }, { industry: 'clinic', features: ['pos'] });
    expect(JSON.stringify(r.structured)).toContain('pk_benh_nhan');
  });

  it('máy chủ chưa nối service ⇒ báo lỗi người dùng đọc được', async () => {
    await expect(setupBuildTool.run({ industry: 'other' }, ctx())).rejects.toThrow(/chưa bật/);
  });
});
