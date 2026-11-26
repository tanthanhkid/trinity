import { SetupBuildService } from '../setup-build.service';
import { setupBuildAction } from '../../integrations/mcp/actions/action-template-tools';

function svc(settings: Record<string, string>, objects = false, real = false) {
  const prisma = {
    setting: { findUnique: jest.fn(async ({ where }: { where: { key: string } }) => (where.key in settings ? { value: settings[where.key], key: where.key } : null)) },
    customObject: { findFirst: jest.fn().mockResolvedValue(objects ? { id: 1 } : null) },
  };
  return new SetupBuildService(prisma as never, {} as never, { stored: jest.fn().mockResolvedValue({ payroll: true, pos: false }) } as never, {} as never, { read: jest.fn().mockResolvedValue(null), hasReal: jest.fn().mockResolvedValue(real) } as never);
}

describe('SetupBuildService.isBuilt', () => {
  it('DB mới (chua_dung, không bảng) ⇒ chưa dựng, vào wizard', async () => {
    expect(await svc({ setup_status: 'chua_dung' }).isBuilt()).toBe(false);
    expect(await svc({}).isBuilt()).toBe(false); // dòng vắng không tính
  });
  it('bản cài cũ từ luồng AI: setup_status da_dung/dang_dung dù không có bảng tuỳ biến ⇒ đã dựng (không bị wizard chặn)', async () => {
    expect(await svc({ setup_status: 'da_dung' }).isBuilt()).toBe(true);
    expect(await svc({ setup_status: 'dang_dung' }).isBuilt()).toBe(true);
  });
  it('có bảng tuỳ biến hoặc setup_built ⇒ đã dựng', async () => {
    expect(await svc({ setup_status: 'chua_dung' }, true).isBuilt()).toBe(true);
    expect(await svc({ setup_built: '{}' }).isBuilt()).toBe(true);
  });
  it('fail-open: thiếu dòng setup_status mà đã có dữ liệu thật ⇒ đã dựng; DB mới có chua_dung thì vẫn chưa, dù có dữ liệu', async () => {
    expect(await svc({}, false, true).isBuilt()).toBe(true);
    expect(await svc({}, false, false).isBuilt()).toBe(false);
    expect(await svc({ setup_status: 'chua_dung' }, false, true).isBuilt()).toBe(false);
  });
  it('plan: dựng lại không truyền features giữ phân hệ đang lưu (không tắt payroll), kèm built_at lần đầu', async () => {
    const p = await svc({ setup_built: JSON.stringify({ built_at: '2026-11-01T00:00:00Z' }) }).plan('clinic');
    expect(p.features).toContain('payroll');
    expect(p.features).not.toContain('pos');
    expect(p.firstBuiltAt).toBe('2026-11-01T00:00:00Z');
    expect(p.rebuild).toBe(true);
  });
});

describe('tool setup_build đi qua đường đề xuất/duyệt', () => {
  const user = { userId: 1, grants: {} } as never;
  const deps = (live: string[], on: Record<string, boolean>) => ({
    setupBuild: { plan: jest.fn().mockResolvedValue({ features: ['dashboard', 'contacts', 'kanban', 'reports'], firstBuiltAt: null, rebuild: false }) },
    prisma: { customObject: { findMany: jest.fn().mockResolvedValue(live.map((key) => ({ key }))) } },
    orgFeatures: { get: jest.fn().mockResolvedValue(on) },
  }) as never;

  it('cần cả hai quyền quản trị và là tool ghi (action)', () => {
    expect(setupBuildAction.permissions).toEqual(['custom_objects.manage', 'settings.features']);
  });
  it('tạo bảng mới mà thiếu confirmed_by_user ⇒ từ chối, kèm danh sách bảng', async () => {
    await expect(setupBuildAction.prepare({ industry: 'clinic' }, { deps: deps([], {}), user })).rejects.toThrow(/chưa có lời người dùng đồng ý/);
  });
  it('tắt phân hệ đang bật mà thiếu confirmed_by_user ⇒ từ chối; có lời đồng ý thì qua', async () => {
    const d = deps(['pk_benh_nhan', 'pk_lich_hen', 'pk_dieu_tri'], { payroll: true, dashboard: true });
    await expect(setupBuildAction.prepare({ industry: 'clinic', features: [] }, { deps: d, user })).rejects.toThrow(/TẮT/);
    const ok = await setupBuildAction.prepare({ industry: 'clinic', features: [], confirmed_by_user: 'ok tắt đi' }, { deps: d, user });
    expect(ok.params).toEqual({ industry: 'clinic', features: [] });
  });
  it('không tạo bảng, không tắt gì ⇒ không cần xác nhận', async () => {
    const d = deps(['pk_benh_nhan', 'pk_lich_hen', 'pk_dieu_tri'], { dashboard: true });
    const ok = await setupBuildAction.prepare({ industry: 'clinic' }, { deps: d, user });
    expect(ok.summary).toMatch(/0 bảng mới/);
  });
  it('ngành lạ bị từ chối', async () => {
    await expect(setupBuildAction.prepare({ industry: 'xx' }, { deps: deps([], {}), user })).rejects.toThrow(/không hợp lệ/);
  });
});
