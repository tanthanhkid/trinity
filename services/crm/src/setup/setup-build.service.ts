import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { trackProductEvent } from '@trinity/logger';
import { SETUP_STATUS_SETTING_KEY, can, INDUSTRY_PRESETS, isIndustryKey, resolveBuildFeatures, resolveOrgFeatures, LOCKED_FEATURES, ORG_FEATURE_KEYS, INDUSTRY_KEYS, type IndustryKey, type OrgFeatureKey } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { CustomObjectTemplatesService } from '../custom-objects/custom-object-templates.service';
import { OrgFeaturesService } from '../settings/org-features.service';
import { SampleRecordsService } from '../sample-records/sample-records.service';
import { SetupStatusService } from './setup-status.service';

/** Ngành đã chọn khi dựng — 1 dòng `settings` (khoá riêng để bước "Chọn ngành" của wizard kiểm thật). */
export const SETUP_INDUSTRY_KEY = 'setup_industry';
/** Đã bấm "Dựng hệ thống": `{industry, features, built_at, built_by}` (JSON). */
export const SETUP_BUILT_KEY = 'setup_built';

export interface BuildInput {
  industry: string;
  /** Phân hệ muốn dùng; vắng = bộ gợi ý của ngành. Bộ cơ bản luôn bật. */
  features?: string[] | null;
}

export interface BuildResult {
  industry: IndustryKey;
  features: OrgFeatureKey[];
  created_objects: string[];
  existing_objects: string[];
  sample_records: number;
  sample_contacts: number;
  setup_status: 'da_dung';
}

/**
 * "Dựng hệ thống" — chọn loại doanh nghiệp + phân hệ rồi dựng MỘT lần, không cần AI: lưu tính năng của tổ chức, áp mẫu ngành
 * (bảng + trường + liên kết), kèm vài bản ghi MẪU (tự xoá khi có bản ghi thật đầu tiên), đặt trạng thái đã dựng. Chạy lại được:
 * bảng đã có thì giữ, bản ghi mẫu chỉ sinh khi bảng vừa mới tạo. Dùng chung cho wizard (web) và tool MCP `setup_build`.
 */
@Injectable()
export class SetupBuildService {
  private readonly logger = new Logger(SetupBuildService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: CustomObjectTemplatesService,
    private readonly features: OrgFeaturesService,
    private readonly setup: SetupStatusService,
    private readonly samples: SampleRecordsService,
  ) {}

  /**
   * Đã dựng: bấm "Dựng" (`setup_built`), hoặc bản cài cũ — có bảng tuỳ biến do AI dựng, hoặc `setup_status` ĐÃ GHI là da_dung/dang_dung
   * (luồng AI cũ: propose_workspace/complete_setup). DB mới từ migration khởi tạo là chua_dung nên vẫn vào wizard; dòng vắng không tính.
   */
  async isBuilt(): Promise<boolean> {
    const [row, obj, status] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: SETUP_BUILT_KEY }, select: { key: true } }),
      this.prisma.customObject.findFirst({ where: { deleted_at: null, is_active: true }, select: { id: true } }),
      this.prisma.setting.findUnique({ where: { key: SETUP_STATUS_SETTING_KEY }, select: { value: true } }),
    ]);
    const s = status?.value?.trim();
    return row != null || obj != null || s === 'da_dung' || s === 'dang_dung';
  }

  /** Phân hệ sẽ bật khi dựng (+ built_at lần đầu nếu đã dựng): dựng lại không truyền `features` thì GIỮ cấu hình đang lưu, không tắt gì. */
  async plan(industry: IndustryKey, chosen?: string[] | null): Promise<{ features: OrgFeatureKey[]; firstBuiltAt: string | null; rebuild: boolean }> {
    const prev = await this.prisma.setting.findUnique({ where: { key: SETUP_BUILT_KEY }, select: { value: true } });
    let firstBuiltAt: string | null = null;
    try { firstBuiltAt = prev?.value ? ((JSON.parse(prev.value) as { built_at?: string }).built_at ?? null) : null; } catch { firstBuiltAt = null; }
    if (chosen == null && prev) {
      const kept = resolveOrgFeatures(await this.features.stored());
      return { features: ORG_FEATURE_KEYS.filter((k) => kept[k] || LOCKED_FEATURES.includes(k)), firstBuiltAt, rebuild: true };
    }
    return { features: resolveBuildFeatures(industry, chosen), firstBuiltAt, rebuild: !!prev };
  }

  async build(user: AuthUser, input: BuildInput): Promise<BuildResult> {
    if (!can(user.grants, 'custom_objects.manage') || !can(user.grants, 'settings.features')) {
      throw new ForbiddenException('Dựng hệ thống cần quyền quản trị (quản lý tính năng tuỳ biến và tính năng của công ty).');
    }
    if (!isIndustryKey(input.industry)) {
      throw new BadRequestException(`Loại doanh nghiệp không hợp lệ. Chọn một trong: ${INDUSTRY_KEYS.join(', ')}.`);
    }
    if (input.features != null && !Array.isArray(input.features)) throw new BadRequestException('Danh sách phân hệ phải là mảng.');
    const industry = input.industry;
    const preset = INDUSTRY_PRESETS[industry];
    const { features, firstBuiltAt } = await this.plan(industry, input.features);
    // Mẫu chỉ sinh khi công ty CHƯA có dữ liệu thật (dựng lại trên hệ thống đang chạy không chèn dữ liệu giả vào lẫn).
    const wantSamples = !(await this.samples.hasReal(await this.samples.read())) && can(user.grants, 'custom_records.manage');

    let created: string[] = [];
    let existing: string[] = [];
    let sampleRecords = 0;
    let sampleContacts = 0;
    if (preset.template) {
      const r = await this.templates.apply(user, preset.template, wantSamples, { sampleObjects: 1, trackSamples: true });
      created = r.created;
      existing = r.existing;
      sampleRecords = r.sample_records;
    } else if (wantSamples) {
      // Cùng khoá với nhánh mẫu bảng: 2 lần dựng đồng thời không tạo mẫu trùng; đọc lại danh sách mẫu TRONG khoá.
      sampleContacts = await this.prisma.$transaction(async (tx) => {
        await this.samples.lock(tx);
        if (await this.samples.read(tx)) return 0;
        return (await this.samples.seedContacts(tx, user.userId)).length;
      });
      if (sampleContacts) await this.samples.dropContactCountCache();
    }

    await this.features.replaceAll(features, user.userId);
    const now = firstBuiltAt && !Number.isNaN(Date.parse(firstBuiltAt)) ? firstBuiltAt : new Date().toISOString();
    const built = JSON.stringify({ industry, features, built_at: now, built_by: user.userId });
    await this.prisma.$transaction([
      this.prisma.setting.upsert({ where: { key: SETUP_INDUSTRY_KEY }, update: { value: industry, updated_by: user.userId }, create: { key: SETUP_INDUSTRY_KEY, value: industry, updated_by: user.userId } }),
      this.prisma.setting.upsert({ where: { key: SETUP_BUILT_KEY }, update: { value: built, updated_by: user.userId }, create: { key: SETUP_BUILT_KEY, value: built, updated_by: user.userId } }),
    ]);
    await this.setup.set('da_dung', user.userId);
    trackProductEvent('workspace_built', user.userId, { industry, features: features.length });
    this.logger.log(`dựng hệ thống: ngành ${industry}, ${features.length} phân hệ, bảng mới [${created}], mẫu ${sampleRecords + sampleContacts}`);
    return { industry, features, created_objects: created, existing_objects: existing, sample_records: sampleRecords, sample_contacts: sampleContacts, setup_status: 'da_dung' };
  }
}
