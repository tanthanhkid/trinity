import { Injectable, NotFoundException } from '@nestjs/common';
import { OrgFeaturesService } from '../settings/org-features.service';

/** Cờ tổ chức + gói `google_sheets` — dùng chung `OrgFeaturesService.isEnabled` (fail-open khi đọc lỗi). */
@Injectable()
export class GoogleFeatureService {
  constructor(private readonly orgFeatures: OrgFeaturesService) {}

  isEnabled(): Promise<boolean> {
    return this.orgFeatures.isEnabled('google_sheets');
  }

  async assertEnabled(): Promise<void> {
    if (!(await this.isEnabled())) throw new NotFoundException('Tính năng Google Sheets đang tắt hoặc không có trong gói');
  }
}
