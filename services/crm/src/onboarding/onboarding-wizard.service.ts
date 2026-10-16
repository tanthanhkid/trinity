import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { trackProductEvent } from '@trinity/logger';
import { can, type Grants } from '@trinity/rbac';
import { oauthEnabled } from '../integrations/oauth/oauth-config';
import { OrgFeaturesService } from '../settings/org-features.service';
import { SocialAccountsService } from '../social/social-accounts.service';

/**
 * Wizard bắt đầu — người dùng phải đi hết các bước (máy chủ KIỂM THẬT từng bước) mới vào được ứng dụng.
 * Bước "Kết nối AI" là của riêng từng người; các bước còn lại tính theo công ty, nên người vào sau
 * thường chỉ phải nối AI của mình. Xong một lần thì ghi `onboarding_done:user:<id>` và không bao giờ khoá lại.
 */
export const WIZARD_STEPS = ['ai', 'build', 'data', 'channels', 'post'] as const;
export type WizardStepKey = (typeof WIZARD_STEPS)[number];
export const isWizardStep = (v: unknown): v is WizardStepKey => typeof v === 'string' && (WIZARD_STEPS as readonly string[]).includes(v);

/** Cấu hình — 1 dòng `settings.onboarding_wizard` (JSON). Vắng = bật, chỉ bước "Đăng bài đầu tiên" được bỏ qua (đăng là lên kênh thật), không miễn ai. */
export const WIZARD_CONFIG_KEY = 'onboarding_wizard';
export interface WizardConfig {
  /** false = tắt hẳn wizard (ai cũng vào thẳng ứng dụng). */
  enabled: boolean;
  /** Bước được phép bấm "Bỏ qua". */
  skippable: WizardStepKey[];
  /** Miễn wizard cho tài khoản tạo TRƯỚC thời điểm này (ISO) — dùng khi không muốn khoá người đang dùng. */
  exempt_before: string | null;
}
export const DEFAULT_WIZARD_CONFIG: WizardConfig = { enabled: true, skippable: ['post'], exempt_before: null };

export const wizardDoneKey = (userId: number): string => `onboarding_done:user:${userId}`;
export const wizardSkipKey = (userId: number): string => `onboarding_skip:user:${userId}`;

/** Quyền cần để TỰ làm bước (thiếu thì bước vẫn bắt buộc, màn hình nhờ quản trị viên làm). */
const STEP_PERMISSION: Partial<Record<WizardStepKey, Parameters<typeof can>[1]>> = {
  build: 'custom_objects.manage',
  channels: 'social.manage',
  post: 'social.post',
};

/** Chưa đạt thì nói rõ thiếu gì và làm sao — lời cho người dùng thường, không thuật ngữ. */
const MISSING: Record<WizardStepKey, string> = {
  ai: 'Trinity chưa thấy trợ lý AI của bạn gọi vào. Làm theo hướng dẫn kết nối ở trên, sau đó hỏi AI một câu, ví dụ "Trinity của mình đang có gì?". AI trả lời xong thì bấm lại nút này.',
  build: 'Công ty chưa có danh sách nào được dựng. Chép câu mẫu, dán vào khung chat với trợ lý AI, trả lời các câu AI hỏi và đồng ý để AI dựng. Dựng xong thì bấm lại nút này.',
  data: 'Trinity chưa có khách hàng hay bản ghi nào. Nhờ trợ lý AI nhập file bạn đang dùng, hoặc nhờ AI thêm một khách đầu tiên. Xong thì bấm lại nút này.',
  channels: 'Chưa có kênh nào đang hoạt động. Bấm "Liên kết" ở Facebook hoặc YouTube, đồng ý trên trang của Facebook/Google, chờ kênh hiện "Hoạt động" rồi bấm lại nút này.',
  post: 'Chưa có bài nào đăng thành công. Soạn một bài, chọn kênh, bấm "Đăng ngay" (hoặc nhờ trợ lý AI đăng giúp), chờ bài báo đã đăng rồi bấm lại nút này.',
};
const MISSING_AI_IDLE = 'Bạn đã cho phép trợ lý AI vào Trinity nhưng AI chưa hỏi Trinity lần nào. Mở khung chat với trợ lý AI, hỏi "Trinity của mình đang có gì?", AI trả lời xong thì bấm lại nút này.';
const NEED_ADMIN = ' Bước này cần quyền quản trị: nếu bạn không thấy nút để làm, hãy nhờ quản trị viên của công ty làm giúp.';

export interface WizardStepView {
  key: WizardStepKey;
  done: boolean;
  skipped: boolean;
  can_skip: boolean;
  /** Người đang xem thiếu quyền tự làm bước này. */
  needs_admin: boolean;
}
export interface WizardView {
  enabled: boolean;
  completed: boolean;
  current: WizardStepKey | null;
  steps: WizardStepView[];
}
export interface ConfirmResult {
  ok: boolean;
  message: string | null;
  wizard: WizardView;
}

export function parseWizardConfig(raw: string | null | undefined): WizardConfig {
  if (!raw) return { ...DEFAULT_WIZARD_CONFIG };
  try {
    const v = JSON.parse(raw) as Partial<WizardConfig>;
    return {
      enabled: v.enabled !== false,
      skippable: Array.isArray(v.skippable) ? v.skippable.filter(isWizardStep) : [...DEFAULT_WIZARD_CONFIG.skippable],
      exempt_before: typeof v.exempt_before === 'string' && !Number.isNaN(Date.parse(v.exempt_before)) ? v.exempt_before : null,
    };
  } catch {
    return { ...DEFAULT_WIZARD_CONFIG };
  }
}

@Injectable()
export class OnboardingWizardService {
  private readonly logger = new Logger(OnboardingWizardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly features: OrgFeaturesService,
    private readonly social: SocialAccountsService,
  ) {}

  private async readSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
  }

  private async writeSetting(key: string, value: string, userId: number): Promise<void> {
    await this.prisma.setting.upsert({ where: { key }, update: { value, updated_by: userId }, create: { key, value, updated_by: userId } });
  }

  async config(): Promise<WizardConfig> {
    return parseWizardConfig(await this.readSetting(WIZARD_CONFIG_KEY));
  }

  async setConfig(patch: Partial<WizardConfig>, userId: number): Promise<WizardConfig> {
    const cur = await this.config();
    const next = parseWizardConfig(JSON.stringify({ ...cur, ...patch }));
    await this.writeSetting(WIZARD_CONFIG_KEY, JSON.stringify(next), userId);
    return next;
  }

  /** Bước nào áp dụng cho công ty này: tắt tính năng / máy chủ chưa cấu hình mạng nào thì không bắt làm bước không làm nổi. */
  private async applicable(): Promise<WizardStepKey[]> {
    const f = await this.features.get();
    const nets = this.social.networks().filter((n) => n.configured);
    const social = f.social_posting !== false && nets.length > 0;
    const page = f.facebook_page !== false && nets.some((n) => n.network === 'facebook');
    return WIZARD_STEPS.filter((k) => {
      if (k === 'ai') return oauthEnabled();
      if (k === 'channels') return social || page;
      if (k === 'post') return social;
      return true;
    });
  }

  /** Kiểm THẬT từng bước theo dữ liệu. AI: chính người này có phiên AI đã thực sự gọi vào Trinity. */
  async checks(userId: number): Promise<Record<WizardStepKey, boolean> & { ai_granted: boolean }> {
    const exists = (p: Promise<unknown>) => p.then((r) => r != null);
    const [aiUsed, aiGranted, workspace, record, contact, account, page, post] = await Promise.all([
      exists(this.prisma.oauthToken.findFirst({ where: { user_id: userId, revoked_at: null, last_used_at: { not: null } }, select: { id: true } })),
      exists(this.prisma.oauthToken.findFirst({ where: { user_id: userId, revoked_at: null }, select: { id: true } })),
      exists(this.prisma.customObject.findFirst({ where: { deleted_at: null, is_active: true }, select: { id: true } })),
      exists(this.prisma.customRecord.findFirst({ where: { deleted_at: null }, select: { id: true } })),
      exists(this.prisma.contact.findFirst({ where: { deleted_at: null }, select: { id: true } })),
      exists(this.prisma.socialAccount.findFirst({ where: { status: 'active' }, select: { id: true } })),
      exists(this.prisma.facebookPage.findFirst({ where: { is_active: true }, select: { id: true } })),
      exists(this.prisma.socialPostTarget.findFirst({ where: { status: 'published' }, select: { id: true } })),
    ]);
    return { ai: aiUsed, ai_granted: aiGranted, build: workspace, data: record || contact, channels: account || page, post };
  }

  private async skipped(userId: number): Promise<WizardStepKey[]> {
    try {
      const v = JSON.parse((await this.readSetting(wizardSkipKey(userId))) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter(isWizardStep) : [];
    } catch {
      return [];
    }
  }

  private async exempt(userId: number, cfg: WizardConfig): Promise<boolean> {
    if (!cfg.exempt_before) return false;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { created_at: true } });
    return !!u && u.created_at.getTime() < Date.parse(cfg.exempt_before);
  }

  async view(userId: number, grants: Grants): Promise<WizardView> {
    const cfg = await this.config();
    if (!cfg.enabled) return { enabled: false, completed: true, current: null, steps: [] };
    const [doneFlag, isExempt, steps, checks, skipped] = await Promise.all([
      this.readSetting(wizardDoneKey(userId)),
      this.exempt(userId, cfg),
      this.applicable(),
      this.checks(userId),
      this.skipped(userId),
    ]);
    const list: WizardStepView[] = steps.map((key) => {
      const perm = STEP_PERMISSION[key];
      return {
        key,
        done: checks[key],
        skipped: !checks[key] && skipped.includes(key) && cfg.skippable.includes(key),
        can_skip: cfg.skippable.includes(key),
        needs_admin: !!perm && !can(grants, perm),
      };
    });
    const current = list.find((s) => !s.done && !s.skipped)?.key ?? null;
    return { enabled: true, completed: !!doneFlag || isExempt, current, steps: list };
  }

  /** "Tôi đã làm xong": kiểm lại bước; đạt và mọi bước đã qua ⇒ ghi xong wizard. */
  async confirm(userId: number, grants: Grants, step: WizardStepKey, skipped = false): Promise<ConfirmResult> {
    let wizard = await this.view(userId, grants);
    const s = wizard.steps.find((x) => x.key === step);
    if (!s) throw new BadRequestException('Bước này không có trong phần bắt đầu của công ty bạn.');
    if (!s.done && !s.skipped) {
      const checks = step === 'ai' ? await this.checks(userId) : null;
      const base = step === 'ai' && checks?.ai_granted ? MISSING_AI_IDLE : MISSING[step];
      return { ok: false, message: base + (s.needs_admin ? NEED_ADMIN : ''), wizard };
    }
    trackProductEvent('onboarding_step', userId, { step, action: skipped ? 'skip' : 'confirm' });
    if (!wizard.completed && wizard.current === null) {
      await this.writeSetting(wizardDoneKey(userId), new Date().toISOString(), userId);
      this.logger.log(`user ${userId} xong wizard bắt đầu`);
      wizard = { ...wizard, completed: true };
    }
    return { ok: true, message: null, wizard };
  }

  async skip(userId: number, grants: Grants, step: WizardStepKey): Promise<ConfirmResult> {
    const cfg = await this.config();
    if (!cfg.skippable.includes(step)) throw new BadRequestException('Bước này bắt buộc, không bỏ qua được.');
    const cur = await this.skipped(userId);
    if (!cur.includes(step)) await this.writeSetting(wizardSkipKey(userId), JSON.stringify([...cur, step]), userId);
    return this.confirm(userId, grants, step, true);
  }
}
