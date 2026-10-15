import 'reflect-metadata';
import { RBAC_META } from '@trinity/rbac-nest';
import type { Grants } from '@trinity/rbac';
import { ORG_FEATURE_KEYS, DEFAULT_OFF_FEATURES } from '@trinity/rbac';
import { OrgFeaturesService } from '../../settings/org-features.service';
import { SetupController } from '../setup.controller';
import { SetupStatusService } from '../setup-status.service';

const user = (grants: Record<string, unknown>) => ({ userId: 5, email: 'a@x.vn', isAdmin: false, grants: grants as Grants });

function prismaWith(settings: Record<string, string>) {
  return {
    setting: {
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { key: string } }) => (where.key in settings ? { value: settings[where.key] } : null)),
      upsert: jest.fn().mockResolvedValue({}),
    },
    oauthToken: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('SetupStatusService', () => {
  it('khoá vắng ⇒ da_dung; lỗi DB ⇒ da_dung (không khoá nhầm hệ thống đang dùng)', async () => {
    expect(await new SetupStatusService(prismaWith({}) as never).get()).toBe('da_dung');
    const bad = prismaWith({});
    bad.setting.findUnique.mockRejectedValue(new Error('db'));
    expect(await new SetupStatusService(bad as never).get()).toBe('da_dung');
  });
  it('đọc chua_dung', async () => {
    expect(await new SetupStatusService(prismaWith({ setup_status: 'chua_dung' }) as never).get()).toBe('chua_dung');
  });
});

describe('OrgFeaturesService theo trạng thái dựng', () => {
  const svc = (settings: Record<string, string>) => {
    const p = prismaWith(settings);
    return new OrgFeaturesService(p as never, new SetupStatusService(p as never));
  };
  it('chua_dung + chưa lưu ⇒ chỉ Kết nối & AI bật', async () => {
    const f = await svc({ setup_status: 'chua_dung' }).get();
    expect(ORG_FEATURE_KEYS.filter((k) => f[k])).toEqual(['integrations']);
  });
  it('da_dung + chưa lưu ⇒ bật hết như cũ', async () => {
    const f = await svc({ setup_status: 'da_dung' }).get();
    expect(ORG_FEATURE_KEYS.every((k) => f[k] === !DEFAULT_OFF_FEATURES.has(k))).toBe(true);
  });
  it('org_features cũ thiếu khoá dashboard/contacts ⇒ hai khoá mới vẫn BẬT', async () => {
    const f = await svc({ org_features: JSON.stringify({ newsfeed: false, kanban: true }) }).get();
    expect(f.dashboard).toBe(true);
    expect(f.contacts).toBe(true);
    expect(f.newsfeed).toBe(false);
  });
  it('replaceAll ghi ĐỦ khoá: ngoài danh sách bật là TẮT tường minh', async () => {
    const p = prismaWith({});
    const s = new OrgFeaturesService(p as never, new SetupStatusService(p as never));
    const out = await s.replaceAll(['kanban', 'integrations'], 1);
    expect(Object.keys(out).sort()).toEqual([...ORG_FEATURE_KEYS].sort());
    expect(ORG_FEATURE_KEYS.filter((k) => out[k]).sort()).toEqual(['integrations', 'kanban']);
    expect(p.setting.upsert).toHaveBeenCalled();
  });
});

describe('SetupController', () => {
  const meta = (m: keyof SetupController) => Reflect.getMetadata(RBAC_META, SetupController.prototype[m] as unknown as () => void);
  it('status = AuthOnly, complete = custom_objects.manage', () => {
    expect(meta('status')).toEqual({ kind: 'auth' });
    expect(meta('complete')).toEqual({ kind: 'can', permissions: ['custom_objects.manage'], mode: 'all' });
  });
  it('status trả can_build theo quyền; complete từ chối khi chua_dung', async () => {
    const p = prismaWith({ setup_status: 'chua_dung' });
    const c = new SetupController(new SetupStatusService(p as never));
    const r = await c.status(user({ 'custom_objects.manage': true }) as never);
    expect(r).toMatchObject({ status: 'chua_dung', can_build: true, ai_connected: false });
    await expect(c.complete(user({}) as never)).rejects.toThrow(/Chưa dựng/);
  });
  it(' token còn nhưng lâu không dùng ⇒ granted nhưng KHÔNG active; mới dùng ⇒ active', async () => {
    const p = prismaWith({});
    const svc = new SetupStatusService(p as never);
    expect(await svc.aiConnection(5)).toEqual({ granted: false, active: false, last_active_at: null });
    const old = new Date(Date.now() - 3 * 3600_000);
    p.oauthToken.findMany.mockResolvedValue([{ last_used_at: null, created_at: old }]);
    expect(await svc.aiConnection(5)).toMatchObject({ granted: true, active: false });
    p.oauthToken.findMany.mockResolvedValue([{ last_used_at: new Date(), created_at: old }]);
    expect(await svc.aiConnection(5)).toMatchObject({ granted: true, active: true });
  });
  it('complete: dang_dung ⇒ da_dung', async () => {
    const p = prismaWith({ setup_status: 'dang_dung' });
    const c = new SetupController(new SetupStatusService(p as never));
    await expect(c.complete(user({}) as never)).resolves.toEqual({ status: 'da_dung' });
    expect(p.setting.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ value: 'da_dung' }) }));
  });
});

describe('Hướng dẫn người mới (onboarding)', () => {
  const build = (found: Partial<Record<'workspace' | 'record' | 'contact' | 'account' | 'page' | 'post', boolean>>, settings: Record<string, string> = {}) => {
    const p = prismaWith(settings);
    const hit = (k: keyof typeof found) => jest.fn().mockResolvedValue(found[k] ? { id: 1 } : null);
    const q = Object.assign(p, {
      customObject: { findFirst: hit('workspace') },
      customRecord: { findFirst: hit('record') },
      contact: { findFirst: hit('contact') },
      socialAccount: { findFirst: hit('account') },
      facebookPage: { findFirst: hit('page') },
      socialPostTarget: { findFirst: hit('post') },
    });
    return { p: q, svc: new SetupStatusService(q as never) };
  };

  it('công ty trống, chưa xem ⇒ mọi bước chưa xong', async () => {
    expect(await build({}).svc.onboarding(5)).toEqual({ seen: false, ai_connected: false, workspace_built: false, has_data: false, channel_linked: false, first_post: false });
  });

  it('dấu xong theo dữ liệu thật: khách hoặc bản ghi ⇒ có dữ liệu; Fanpage hoặc kênh đăng bài ⇒ đã nối kênh', async () => {
    const { p, svc } = build({ workspace: true, contact: true, page: true, post: true }, { 'onboarding_seen:user:5': '2026-10-13' });
    p.oauthToken.findMany.mockResolvedValue([{ last_used_at: null, created_at: new Date() }]);
    expect(await svc.onboarding(5)).toEqual({ seen: true, ai_connected: true, workspace_built: true, has_data: true, channel_linked: true, first_post: true });
    expect(p.socialPostTarget.findFirst).toHaveBeenCalledWith({ where: { status: 'published' }, select: { id: true } });
  });

  it('đánh dấu đã xem theo từng người; API là AuthOnly', async () => {
    const { p, svc } = build({});
    await new SetupController(svc).onboardingSeen(user({}) as never);
    expect(p.setting.upsert.mock.calls[0][0].where).toEqual({ key: 'onboarding_seen:user:5' });
    const meta = (m: keyof SetupController) => Reflect.getMetadata(RBAC_META, SetupController.prototype[m] as unknown as () => void);
    expect(meta('onboarding')).toEqual({ kind: 'auth' });
    expect(meta('onboardingSeen')).toEqual({ kind: 'auth' });
  });
});
