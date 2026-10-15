import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * PUT /settings/org-features — cập nhật MỘT PHẦN: chỉ khoá nào gửi lên mới đổi,
 * khoá vắng giữ nguyên. Danh sách khoá khớp `ORG_FEATURES` (@trinity/rbac);
 * `ServiceAwareValidationPipe` có `forbidNonWhitelisted` nên khoá lạ → 400.
 * Test `org-features.spec.ts` khoá việc DTO này đủ khoá của danh mục.
 */
export class UpdateOrgFeaturesDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() dashboard?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() contacts?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() reports?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() newsfeed?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() kanban?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() attendance?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() payroll?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() products?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pos?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() management?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() integrations?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() ai_briefing?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() zalo_oa?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() lead_scoring?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() google_sheets?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() stale_reminders?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() facebook_page?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() social_posting?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() payments?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() commerce_connectors?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() online_store?: boolean;
}
