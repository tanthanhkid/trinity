import { BadRequestException } from '@nestjs/common';
import type { Grants } from '@trinity/rbac';
import { OnboardingWizardService, parseWizardConfig, wizardDoneKey, wizardSkipKey } from '../onboarding-wizard.service';

const ADMIN = { 'custom_objects.manage': true, 'social.manage': true, 'social.post': true } as unknown as Grants;
const NOBODY = {} as Grants;

interface Data {
  settings?: Record<string, string>;
  /** Công ty đã dựng (bấm "Dựng hệ thống" hoặc bản cài cũ đã có bảng tuỳ biến). */
  built?: boolean;
  /** Có khách/bản ghi THẬT. */
  real?: boolean;
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
    socialAccount: { findFirst: row(d.account) },
    facebookPage: { findFirst: row(false) },
    socialPostTarget: { findFirst: row(d.post) },
    user: { findUnique: jest.fn().mockResolvedValue({ created_at: d.createdAt ?? new Date('2026-10-13T12:00:00Z') }) },
  };
  const build = { isBuilt: jest.fn().mockResolvedValue(!!d.built) };
  const samples = {
    read: jest.fn().mockResolvedValue(null),
    hasReal: jest.fn().mockResolvedValue(!!d.real),
    purgeIfReal: jest.fn().mockResolvedValue(false),
  };
  const svc = new OnboardingWizardService(
    prisma as never,
    { get: jest.fn().mockResolvedValue(features) } as never,
    { networks: () => networks } as never,
    build as never,
    samples as never,
  );
  return { svc, settings, samples };
}

describe('parseWizardConfig', () => {
  it('vắng/rác ⇒ bật, được bỏ qua dữ liệu/kênh/đăng bài, không miễn', () => {
    const def = { enabled: true, skippable: ['data', 'channels', 'post'], exempt_before: null };
    expect(parseWizardConfig(null)).toEqual(def);
    expect(parseWizardConfig('{rác')).toEqual(def);
    expect(parseWizardConfig('{"enabled":true}')).toEqual(def);
    expect(parseWizardConfig('{"skippable":[]}')).toEqual({ ...def, skippable: [] });
    expect(parseWizardConfig('{"skippable":["post","ai","xx"],"exempt_before":"không phải ngày"}')).toEqual({ ...def, skippable: ['post'] });
  });
});

describe('OnboardingWizardService', () => {
  it('công ty trống: đủ 5 bước, không còn bước nối AI, đang ở bước chọn loại doanh nghiệp', async () => {
    const w = await make().svc.view(7, ADMIN);
    expect(w.steps.map((s) => s.key)).toEqual(['industry', 'modules', 'data', 'channels', 'post']);
    expect(w.current).toBe('industry');
    expect(w.completed).toBe(false);
    expect(w.industry).toBeNull();
  });

  it('bấm xác nhận khi chưa dựng ⇒ bị chặn, nói rõ cần làm gì', async () => {
    const r = await make().svc.confirm(7, ADMIN, 'modules');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Dựng hệ thống/);
  });

  it('thiếu quyền ⇒ bước dựng vẫn bắt buộc, lời nhắc nhờ quản trị viên', async () => {
    const r = await make().svc.confirm(7, NOBODY, 'modules');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/quản trị viên/);
    expect(r.wizard.steps.find((s) => s.key === 'modules')?.needs_admin).toBe(true);
  });

  it('bản cài cũ đã có bảng tuỳ biến ⇒ hai bước đầu tự đạt', async () => {
    const w = await make({ built: true }).svc.view(7, ADMIN);
    expect(w.steps.filter((s) => s.done).map((s) => s.key)).toEqual(['industry', 'modules']);
    expect(w.current).toBe('data');
  });

  it('ngành đã lưu: bước chọn ngành đạt, trả về ngành', async () => {
    const w = await make({ settings: { setup_industry: 'clinic' } }).svc.view(7, ADMIN);
    expect(w.industry).toBe('clinic');
    expect(w.steps.find((s) => s.key === 'industry')?.done).toBe(true);
    expect(w.steps.find((s) => s.key === 'modules')?.done).toBe(false);
  });

  it('dữ liệu: chỉ khách/bản ghi THẬT mới qua bước (mẫu không tính)', async () => {
    const onlySamples = await make({ built: true }).svc.view(7, ADMIN);
    expect(onlySamples.steps.find((s) => s.key === 'data')?.done).toBe(false);
    const real = await make({ built: true, real: true }).svc.view(7, ADMIN);
    expect(real.steps.find((s) => s.key === 'data')?.done).toBe(true);
  });

  it('mỗi lần xem wizard đều dọn bản ghi mẫu (lưới an toàn)', async () => {
    const { svc, samples } = make({ built: true });
    await svc.view(7, ADMIN);
    expect(samples.purgeIfReal).toHaveBeenCalled();
  });

  it('đạt hết bước bắt buộc rồi xác nhận ⇒ ghi xong wizard', async () => {
    const { svc, settings } = make({ built: true, real: true, account: true, post: true });
    const r = await svc.confirm(9, NOBODY, 'data');
    expect(r).toMatchObject({ ok: true, wizard: { completed: true, current: null } });
    expect(settings[wizardDoneKey(9)]).toBeDefined();
  });

  it('đạt bước giữa chừng thì chưa xong wizard', async () => {
    const { svc, settings } = make({ built: true, real: true });
    const r = await svc.confirm(7, ADMIN, 'data');
    expect(r).toMatchObject({ ok: true, wizard: { completed: false, current: 'channels' } });
    expect(settings[wizardDoneKey(7)]).toBeUndefined();
  });

  it('người có tài khoản tạo SAU lúc công ty dựng xong vào thẳng ứng dụng, không đi wizard', async () => {
    const built = JSON.stringify({ industry: 'clinic', built_at: '2026-10-13T00:00:00Z' });
    const later = make({ built: true, settings: { setup_built: built }, createdAt: new Date('2026-10-14') });
    expect((await later.svc.view(11, NOBODY)).completed).toBe(true);
    const first = make({ built: true, settings: { setup_built: built }, createdAt: new Date('2026-10-12') });
    expect((await first.svc.view(5, ADMIN)).completed).toBe(false);
  });

  it('đã xong một lần thì không khoá lại dù dữ liệu đổi (kênh bị gỡ…)', async () => {
    const w = await make({ settings: { [wizardDoneKey(7)]: '2026-10-13' } }).svc.view(7, ADMIN);
    expect(w.completed).toBe(true);
  });

  it('bỏ qua: chỉ được khi cấu hình cho phép; dữ liệu/kênh/đăng bài bỏ qua được, chọn ngành thì không', async () => {
    await expect(make({ settings: { onboarding_wizard: '{"skippable":[]}' } }).svc.skip(7, ADMIN, 'post')).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().svc.skip(7, ADMIN, 'industry')).rejects.toBeInstanceOf(BadRequestException);
    const { svc, settings } = make({ built: true, real: true, account: true });
    const r = await svc.skip(7, ADMIN, 'post');
    expect(r).toMatchObject({ ok: true, wizard: { completed: true } });
    expect(JSON.parse(settings[wizardSkipKey(7)])).toEqual(['post']);
  });

  it('bỏ qua "Dữ liệu đầu tiên" khi chỉ có bản ghi mẫu ⇒ đi tiếp được', async () => {
    const { svc } = make({ built: true });
    const r = await svc.skip(7, ADMIN, 'data');
    expect(r.ok).toBe(true);
    expect(r.wizard.steps.find((s) => s.key === 'data')?.skipped).toBe(true);
  });

  it('tắt đăng đa kênh / máy chủ chưa cấu hình mạng nào ⇒ không bắt bước kênh và đăng bài', async () => {
    const off = await make({}, { social_posting: false, facebook_page: false }).svc.view(7, ADMIN);
    expect(off.steps.map((s) => s.key)).toEqual(['industry', 'modules', 'data']);
    const none = await make({}, {}, []).svc.view(7, ADMIN);
    expect(none.steps.map((s) => s.key)).toEqual(['industry', 'modules', 'data']);
  });

  it('tắt wizard / miễn tài khoản tạo trước mốc ⇒ coi như xong', async () => {
    expect((await make({ settings: { onboarding_wizard: '{"enabled":false}' } }).svc.view(7, ADMIN)).completed).toBe(true);
    const old = make({ createdAt: new Date('2026-10-01'), settings: { onboarding_wizard: '{"exempt_before":"2026-10-13T00:00:00Z"}' } });
    expect((await old.svc.view(7, ADMIN)).completed).toBe(true);
    const fresh = make({ createdAt: new Date('2026-10-14'), settings: { onboarding_wizard: '{"exempt_before":"2026-10-13T00:00:00Z"}' } });
    expect((await fresh.svc.view(7, ADMIN)).completed).toBe(false);
  });
});
