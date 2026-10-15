import { BadRequestException } from '@nestjs/common';
import type { Grants } from '@trinity/rbac';
import { OnboardingWizardService, parseWizardConfig, wizardDoneKey, wizardSkipKey } from '../onboarding-wizard.service';

jest.mock('../../integrations/oauth/oauth-config', () => ({ oauthEnabled: () => true }));

const ADMIN = { 'custom_objects.manage': true, 'social.manage': true, 'social.post': true } as unknown as Grants;
const NOBODY = {} as Grants;

interface Data {
  settings?: Record<string, string>;
  aiUsed?: boolean;
  aiGranted?: boolean;
  workspace?: boolean;
  contact?: boolean;
  account?: boolean;
  post?: boolean;
  createdAt?: Date;
}

function make(d: Data = {}, features: Record<string, boolean> = {}, networks = [{ network: 'facebook', configured: true }]) {
  const settings = { ...(d.settings ?? {}) };
  const row = (v: boolean | undefined) => jest.fn().mockResolvedValue(v ? { id: 1 } : null);
  const prisma = {
    setting: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => (where.key in settings ? { value: settings[where.key] } : null)),
      upsert: jest.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        settings[where.key] = create.value;
        return {};
      }),
    },
    oauthToken: {
      findFirst: jest.fn(async ({ where }: { where: { last_used_at?: unknown } }) => ((where.last_used_at ? d.aiUsed : d.aiGranted || d.aiUsed) ? { id: 1 } : null)),
    },
    customObject: { findFirst: row(d.workspace) },
    customRecord: { findFirst: row(false) },
    contact: { findFirst: row(d.contact) },
    socialAccount: { findFirst: row(d.account) },
    facebookPage: { findFirst: row(false) },
    socialPostTarget: { findFirst: row(d.post) },
    user: { findUnique: jest.fn().mockResolvedValue({ created_at: d.createdAt ?? new Date('2026-10-13T12:00:00Z') }) },
  };
  const svc = new OnboardingWizardService(
    prisma as never,
    { get: jest.fn().mockResolvedValue(features) } as never,
    { networks: () => networks } as never,
  );
  return { svc, settings };
}

describe('parseWizardConfig', () => {
  it('vắng/rác ⇒ bật, chỉ bỏ qua được bước đăng bài, không miễn', () => {
    expect(parseWizardConfig(null)).toEqual({ enabled: true, skippable: ['post'], exempt_before: null });
    expect(parseWizardConfig('{rác')).toEqual({ enabled: true, skippable: ['post'], exempt_before: null });
    expect(parseWizardConfig('{"enabled":true}')).toEqual({ enabled: true, skippable: ['post'], exempt_before: null });
    expect(parseWizardConfig('{"skippable":[]}')).toEqual({ enabled: true, skippable: [], exempt_before: null });
    expect(parseWizardConfig('{"skippable":["post","xx"],"exempt_before":"không phải ngày"}')).toEqual({ enabled: true, skippable: ['post'], exempt_before: null });
  });
});

describe('OnboardingWizardService', () => {
  it('công ty trống: đủ 5 bước, đang ở bước kết nối AI, chưa xong', async () => {
    const w = await make().svc.view(7, ADMIN);
    expect(w.steps.map((s) => s.key)).toEqual(['ai', 'build', 'data', 'channels', 'post']);
    expect(w.current).toBe('ai');
    expect(w.completed).toBe(false);
  });

  it('bấm xác nhận khi chưa làm ⇒ bị chặn, nói rõ thiếu gì', async () => {
    const r = await make().svc.confirm(7, ADMIN, 'ai');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/chưa thấy trợ lý AI/);
  });

  it('đã cấp quyền mà AI chưa gọi lần nào ⇒ vẫn chặn, lời nhắc hỏi AI một câu', async () => {
    const r = await make({ aiGranted: true }).svc.confirm(7, ADMIN, 'ai');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/chưa hỏi Trinity lần nào/);
  });

  it('các bước công ty đã đạt thì tự qua: người vào sau chỉ cần nối AI là xong wizard', async () => {
    const { svc, settings } = make({ aiUsed: true, workspace: true, contact: true, account: true, post: true });
    const r = await svc.confirm(9, NOBODY, 'ai');
    expect(r).toMatchObject({ ok: true, wizard: { completed: true, current: null } });
    expect(settings[wizardDoneKey(9)]).toBeDefined();
  });

  it('đạt bước giữa chừng thì chưa xong wizard', async () => {
    const { svc, settings } = make({ aiUsed: true });
    const r = await svc.confirm(7, ADMIN, 'ai');
    expect(r).toMatchObject({ ok: true, wizard: { completed: false, current: 'build' } });
    expect(settings[wizardDoneKey(7)]).toBeUndefined();
  });

  it('thiếu quyền tự làm ⇒ bước vẫn bắt buộc, lời nhắc nhờ quản trị viên', async () => {
    const r = await make({ aiUsed: true }).svc.confirm(7, NOBODY, 'build');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/quản trị viên/);
    expect(r.wizard.steps.find((s) => s.key === 'build')?.needs_admin).toBe(true);
  });

  it('đã xong một lần thì không khoá lại dù dữ liệu đổi (kênh bị gỡ…)', async () => {
    const w = await make({ settings: { [wizardDoneKey(7)]: '2026-10-13' } }).svc.view(7, ADMIN);
    expect(w.completed).toBe(true);
  });

  it('bỏ qua: chỉ được khi cấu hình cho phép — mặc định bước đăng bài bỏ qua được', async () => {
    await expect(make({ settings: { onboarding_wizard: '{"skippable":[]}' } }).svc.skip(7, ADMIN, 'post')).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().svc.skip(7, ADMIN, 'channels')).rejects.toBeInstanceOf(BadRequestException);
    const { svc, settings } = make({ aiUsed: true, workspace: true, contact: true, account: true });
    const r = await svc.skip(7, ADMIN, 'post');
    expect(r).toMatchObject({ ok: true, wizard: { completed: true } });
    expect(JSON.parse(settings[wizardSkipKey(7)])).toEqual(['post']);
  });

  it('tắt đăng đa kênh / máy chủ chưa cấu hình mạng nào ⇒ không bắt bước kênh và đăng bài', async () => {
    const off = await make({}, { social_posting: false, facebook_page: false }).svc.view(7, ADMIN);
    expect(off.steps.map((s) => s.key)).toEqual(['ai', 'build', 'data']);
    const none = await make({}, {}, []).svc.view(7, ADMIN);
    expect(none.steps.map((s) => s.key)).toEqual(['ai', 'build', 'data']);
  });

  it('tắt wizard / miễn tài khoản tạo trước mốc ⇒ coi như xong', async () => {
    expect((await make({ settings: { onboarding_wizard: '{"enabled":false}' } }).svc.view(7, ADMIN)).completed).toBe(true);
    const old = make({ createdAt: new Date('2026-10-01'), settings: { onboarding_wizard: '{"exempt_before":"2026-10-13T00:00:00Z"}' } });
    expect((await old.svc.view(7, ADMIN)).completed).toBe(true);
    const fresh = make({ createdAt: new Date('2026-10-14'), settings: { onboarding_wizard: '{"exempt_before":"2026-10-13T00:00:00Z"}' } });
    expect((await fresh.svc.view(7, ADMIN)).completed).toBe(false);
  });
});
