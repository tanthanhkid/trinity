import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ORG_FEATURES, type OrgFeatureKey } from '@trinity/rbac';
import { OrgFeaturesService } from '../settings/org-features.service';

export const ORG_FEATURE_META = 'trinity:org_feature';

/**
 * Chặn route khi tính năng của tổ chức tắt hoặc không có trong gói — kiểm Ở BE,
 * không chỉ ẩn UI. Dùng: `@RequireOrgFeature('zalo_oa')` trên controller/handler (kèm @Can như thường).
 * Tắt → 403 tiếng Việt. Đọc cấu hình lỗi → cho qua (fail-open, cùng OrgFeaturesService).
 */
@Injectable()
export class OrgFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<OrgFeatureKey | undefined>(ORG_FEATURE_META, [ctx.getHandler(), ctx.getClass()]);
    if (!key) return true;
    if (await this.orgFeatures.isEnabled(key)) return true;
    throw new ForbiddenException(`Tính năng "${ORG_FEATURES[key].label}" chưa bật hoặc không có trong gói hiện tại.`);
  }
}

export const RequireOrgFeature = (key: OrgFeatureKey) =>
  applyDecorators(SetMetadata(ORG_FEATURE_META, key), UseGuards(OrgFeatureGuard));
