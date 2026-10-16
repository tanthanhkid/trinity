import { BadRequestException, Injectable, InternalServerErrorException, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { trackProductEvent } from '@trinity/logger';
import {
  BLANK_SYSTEM_FEATURES,
  ORG_FEATURE_KEYS,
  PLANS,
  PLAN_GATED_FEATURES,
  applyFeatureLocks,
  applyPlanToFeatures,
  resolvePlan,
  type OrgFeatureKey,
  type PlanKey,
  isServerlessRuntime,
  lockedFeatureReasons,
  resolveOrgFeatures,
  type LockedFeatureReasons,
  type OrgFeatures,
} from '@trinity/rbac';
import type { UpdateOrgFeaturesDto } from './dto/org-features.dto';
import { SetupStatusService } from '../setup/setup-status.service';

const KEY = 'org_features';
/** Gói dịch vụ của tổ chức — chuỗi khoá gói; vắng/rác = `custom` (không ràng buộc). */
export const PLAN_SETTING_KEY = 'org_plan';

/** Phản hồi GET/PUT: đủ khoá boolean; thêm `locked` (khoá → lý do) CHỈ khi runtime serverless. */
export type OrgFeaturesResponse = OrgFeatures & { locked?: LockedFeatureReasons };

/**
 * "Tính năng của tổ chức" — công tắc ẩn/hiện UI theo TỔ CHỨC, lưu
 * 1 dòng Setting KV `org_features` (JSON). KHÔNG phải phân quyền: BE các module
 * vẫn kiểm quyền RBAC như cũ, tắt tính năng chỉ ẩn khỏi giao diện.
 * Thiếu khoá/rác/lỗi đọc → BẬT hết (fail-open: không khoá nhầm cả công ty).
 */
@Injectable()
export class OrgFeaturesService {
  private readonly logger = new Logger(OrgFeaturesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly setup?: SetupStatusService,
  ) {}

  /** Mặc định cho khoá THIẾU: hệ thống chưa dựng quy trình ⇒ module cứng TẮT; còn lại BẬT như cũ. */
  private async defaults(): Promise<Partial<OrgFeatures> | undefined> {
    return this.setup && (await this.setup.get()) === 'chua_dung' ? BLANK_SYSTEM_FEATURES : undefined;
  }

  async get(): Promise<OrgFeaturesResponse> {
    try {
      const plan = await this.getPlan();
      return this.withLocks(applyPlanToFeatures(resolveOrgFeatures(await this.readStored(), await this.defaults()), plan));
    } catch (err) {
      this.logger.error(`getOrgFeatures failed: ${(err as Error)?.message}`);
      return this.withLocks(resolveOrgFeatures(undefined));
    }
  }

  /** Tính năng `key` đang bật cho tổ chức (đã tính gói + khoá serverless) — dùng ở guard BE. Lỗi đọc = bật (fail-open như `get`). */
  async isEnabled(key: OrgFeatureKey): Promise<boolean> {
    const f = await this.get();
    return f[key] !== false;
  }

  /** Gói hiện tại; vắng/rác/lỗi đọc = `custom`. */
  async getPlan(): Promise<PlanKey> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: PLAN_SETTING_KEY }, select: { value: true } });
      return resolvePlan(row?.value?.trim());
    } catch (err) {
      this.logger.error(`getPlan failed: ${(err as Error)?.message}`);
      return 'custom';
    }
  }

  /**
   * Đổi gói — CHỈ gọi từ đường của Trinity (header token ở controller, hoặc script CLI `plan:set`).
   * Ghi nhật ký (bảng audit_logs) cùng giao dịch với việc đổi: không có dòng nhật ký thì không đổi.
   */
  async setPlan(plan: PlanKey, userId: number | null, source: 'api' | 'cli' = 'api', ipAddress?: string | null): Promise<PlanKey> {
    const from = await this.getPlan();
    await this.prisma.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key: PLAN_SETTING_KEY },
        update: { value: plan, updated_by: userId },
        create: { key: PLAN_SETTING_KEY, value: plan, updated_by: userId },
      });
      await tx.auditLog.create({
        data: {
          user_id: userId,
          action: 'update',
          resource: 'org_plan',
          ip_address: ipAddress ?? null,
          metadata: { from, to: plan, source },
        },
      });
    });
    this.logger.log(`Org plan ${from} -> ${plan} (${source}, user ${userId ?? '-'})`);
    trackProductEvent('plan_changed', userId, { plan });
    return plan;
  }

  /**
   * Serverless: khoá bị khoá luôn trả `false` + `locked[khoá]` = lý do.
   * Không phải serverless → trả y nguyên như trước (không thêm `locked`).
   */
  private withLocks(features: OrgFeatures): OrgFeaturesResponse {
    const locked = lockedFeatureReasons(isServerlessRuntime());
    if (Object.keys(locked).length === 0) return features;
    return { ...applyFeatureLocks(features, locked), locked };
  }

  /** Cập nhật một phần: chỉ khoá gửi lên (≠ undefined) đổi, khoá vắng giữ nguyên. */
  async update(dto: UpdateOrgFeaturesDto, userId: number): Promise<OrgFeaturesResponse> {
    const locked = lockedFeatureReasons(isServerlessRuntime());
    for (const key of ORG_FEATURE_KEYS) {
      const reason = locked[key];
      if (reason && dto[key] === true) throw new BadRequestException(reason);
    }
    const plan = await this.getPlan();
    const inPlan = new Set<string>(PLANS[plan].features);
    for (const key of PLAN_GATED_FEATURES) {
      if (dto[key] === true && !inPlan.has(key)) {
        throw new BadRequestException(`Gói "${PLANS[plan].label}" không có tính năng này. Nâng gói để bật.`);
      }
    }
    try {
      const next = resolveOrgFeatures(await this.readStored(), await this.defaults());
      for (const key of ORG_FEATURE_KEYS) {
        const v = dto[key];
        if (v !== undefined) next[key] = v;
      }
      const value = JSON.stringify(next);
      await this.prisma.setting.upsert({
        where: { key: KEY },
        update: { value, updated_by: userId },
        create: { key: KEY, value, updated_by: userId },
      });
      this.logger.log(`Org features updated by user ${userId}: ${value}`);
      for (const key of ORG_FEATURE_KEYS) {
        if (dto[key] !== undefined) trackProductEvent('feature_toggled', userId, { feature: key, enabled: dto[key] === true });
      }
      return this.withLocks(applyPlanToFeatures(next, plan));
    } catch (err) {
      this.logger.error(`updateOrgFeatures failed (user=${userId}): ${(err as Error)?.message}`);
      throw new InternalServerErrorException('Không cập nhật được tính năng của tổ chức');
    }
  }

  /**
   * Ghi ĐỦ MỌI khoá (bật = có trong `on`, còn lại TẮT) — dùng khi duyệt gói dựng quy trình: sau khi dựng, khoá
   * nào không được AI bật phải TẮT tường minh (không rơi về "thiếu khoá = BẬT"). Khoá bị gói/runtime khoá vẫn bị ép tắt lúc đọc.
   */
  async replaceAll(on: readonly OrgFeatureKey[], userId: number): Promise<OrgFeatures> {
    const next = Object.fromEntries(ORG_FEATURE_KEYS.map((k) => [k, on.includes(k)])) as OrgFeatures;
    const value = JSON.stringify(next);
    await this.prisma.setting.upsert({ where: { key: KEY }, update: { value, updated_by: userId }, create: { key: KEY, value, updated_by: userId } });
    this.logger.log(`Org features (gói dựng) by user ${userId}: ${value}`);
    return next;
  }

  /** Cấu hình đã lưu (thô, chưa áp mặc định) — để chụp phiên bản trước khi đổi. */
  async stored(): Promise<unknown> {
    return this.readStored();
  }

  private async readStored(): Promise<unknown> {
    const row = await this.prisma.setting.findUnique({ where: { key: KEY }, select: { value: true } });
    if (!row?.value) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  }
}
