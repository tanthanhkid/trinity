import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { OrgFeaturesService } from '../settings/org-features.service';
import { parseHHmm } from './briefing-time';
import { DEFAULT_BRIEFING_CONFIG, type BriefingConfig } from './briefing.types';

const KEY = 'briefing_config';

/** Cấu hình bản tin lưu 1 dòng Setting KV (không cần migration). Thiếu/rác → mặc định (TẮT). */
@Injectable()
export class BriefingConfigService {
  private readonly logger = new Logger(BriefingConfigService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  async get(): Promise<BriefingConfig> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
      return normalizeConfig(row ? JSON.parse(row.value) : undefined);
    } catch (err) {
      this.logger.warn(`Đọc cấu hình bản tin lỗi, dùng mặc định: ${(err as Error)?.message}`);
      return { ...DEFAULT_BRIEFING_CONFIG };
    }
  }

  async update(patch: Partial<BriefingConfig>, userId: number): Promise<BriefingConfig> {
    const next = normalizeConfig({ ...(await this.get()), ...patch });
    const value = JSON.stringify(next);
    await this.prisma.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value, updated_by: userId },
      update: { value, updated_by: userId },
    });
    return next;
  }

  /** Cờ tính năng `ai_briefing`: bật theo công tắc tổ chức + gói dịch vụ; lỗi đọc = bật (fail-open, như OrgFeaturesService). */
  featureOn(): Promise<boolean> {
    return this.orgFeatures.isEnabled('ai_briefing');
  }
}

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const time = (v: unknown, d: string): string => (typeof v === 'string' && parseHHmm(v) ? v : d);

export function normalizeConfig(raw: unknown): BriefingConfig {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_BRIEFING_CONFIG;
  return {
    enabled: bool(s.enabled, d.enabled),
    morning_enabled: bool(s.morning_enabled, d.morning_enabled),
    evening_enabled: bool(s.evening_enabled, d.evening_enabled),
    morning_time: time(s.morning_time, d.morning_time),
    evening_time: time(s.evening_time, d.evening_time),
    in_app: bool(s.in_app, d.in_app),
  };
}
