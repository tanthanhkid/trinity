import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { SETUP_STATUS_SETTING_KEY, resolveSetupStatus, type SetupStatus } from '@trinity/rbac';

/** Quá ngần này không có hoạt động ⇒ không khẳng định AI còn nối. */
export const AI_ACTIVE_WINDOW_MS = 60 * 60 * 1000;

/** Đã xem màn hướng dẫn người mới — 1 dòng `settings` mỗi người (không cần cột mới trên `users`). */
export const onboardingSeenKey = (userId: number): string => `onboarding_seen:user:${userId}`;

/** Tiến độ các bước bắt đầu — dấu "xong" lấy theo dữ liệu thật của công ty (AI là của riêng người đang xem). */
export interface OnboardingProgress {
  seen: boolean;
  ai_connected: boolean;
  workspace_built: boolean;
  has_data: boolean;
  channel_linked: boolean;
  first_post: boolean;
}

export interface AiConnectionState {
  granted: boolean;
  active: boolean;
  last_active_at: Date | null;
}

/**
 * Trạng thái dựng quy trình — 1 dòng `settings.setup_status`. Vắng / rác / lỗi đọc = `da_dung`
 * (fail-open: bản cài đang chạy không bao giờ bị khoá vì thiếu dòng này hay vì DB chập chờn).
 */
@Injectable()
export class SetupStatusService {
  private readonly logger = new Logger(SetupStatusService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<SetupStatus> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: SETUP_STATUS_SETTING_KEY }, select: { value: true } });
      return resolveSetupStatus(row?.value);
    } catch (err) {
      this.logger.error(`đọc setup_status lỗi: ${(err as Error)?.message}`);
      return 'da_dung';
    }
  }

  async set(status: SetupStatus, userId: number | null): Promise<SetupStatus> {
    await this.prisma.setting.upsert({
      where: { key: SETUP_STATUS_SETTING_KEY },
      update: { value: status, updated_by: userId },
      create: { key: SETUP_STATUS_SETTING_KEY, value: status, updated_by: userId },
    });
    this.logger.log(`setup_status -> ${status} (user ${userId ?? '-'})`);
    return status;
  }

  async onboarding(userId: number): Promise<OnboardingProgress> {
    const exists = (p: Promise<unknown>) => p.then((r) => r != null);
    const [seen, ai, workspace, record, contact, account, page, post] = await Promise.all([
      exists(this.prisma.setting.findUnique({ where: { key: onboardingSeenKey(userId) }, select: { key: true } })),
      this.aiConnection(userId),
      exists(this.prisma.customObject.findFirst({ where: { deleted_at: null, is_active: true }, select: { id: true } })),
      exists(this.prisma.customRecord.findFirst({ where: { deleted_at: null }, select: { id: true } })),
      exists(this.prisma.contact.findFirst({ where: { deleted_at: null }, select: { id: true } })),
      exists(this.prisma.socialAccount.findFirst({ where: { status: 'active' }, select: { id: true } })),
      exists(this.prisma.facebookPage.findFirst({ where: { is_active: true }, select: { id: true } })),
      exists(this.prisma.socialPostTarget.findFirst({ where: { status: 'published' }, select: { id: true } })),
    ]);
    return { seen, ai_connected: ai.granted, workspace_built: workspace, has_data: record || contact, channel_linked: account || page, first_post: post };
  }

  async markOnboardingSeen(userId: number): Promise<void> {
    const key = onboardingSeenKey(userId);
    const value = new Date().toISOString();
    await this.prisma.setting.upsert({ where: { key }, update: { value, updated_by: userId }, create: { key, value, updated_by: userId } });
  }

  /**
   * Kết nối AI của mình / của mọi người (token OAuth còn sống, chưa thu hồi). Claude/ChatGPT KHÔNG báo cho Trinity khi người dùng
   * ngắt bên họ, nên "còn token" không có nghĩa "đang nối": chỉ coi là `active` khi có hoạt động trong 1 giờ gần đây
   * (access token sống 1 giờ; AI phải gọi/làm mới mới có hoạt động). Còn lại là `idle` — có quyền cấp nhưng lâu không dùng.
   */
  async aiConnection(userId?: number): Promise<AiConnectionState> {
    const heads = await this.prisma.oauthToken.findMany({
      where: { revoked_at: null, refresh_used_at: null, refresh_expires_at: { gt: new Date() }, ...(userId ? { user_id: userId } : {}) },
      select: { last_used_at: true, created_at: true },
      orderBy: { id: 'desc' },
      take: 200,
    });
    if (heads.length === 0) return { granted: false, active: false, last_active_at: null };
    const times = heads.map((h) => (h.last_used_at ?? h.created_at).getTime());
    const last = Math.max(...times);
    return { granted: true, active: Date.now() - last <= AI_ACTIVE_WINDOW_MS, last_active_at: new Date(last) };
  }
}
