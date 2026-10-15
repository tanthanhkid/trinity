import { Injectable } from '@nestjs/common';
import { OrgFeaturesService } from '../settings/org-features.service';

/** Cờ/gói `zalo_oa` cho đường KHÔNG đi qua guard (webhook: tắt thì vẫn trả 200 nhưng bỏ qua). Fail-open như OrgFeaturesService. */
@Injectable()
export class ZaloOaFeatureService {
  constructor(private readonly features: OrgFeaturesService) {}

  isEnabled(): Promise<boolean> {
    return this.features.isEnabled('zalo_oa');
  }
}
