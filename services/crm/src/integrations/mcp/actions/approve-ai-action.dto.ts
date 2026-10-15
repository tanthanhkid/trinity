import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** Thân POST /integrations/ai-actions/:id/approve. Đổi cấu trúc ảnh hưởng dữ liệu ⇒ gõ lại tên bảng. */
export class ApproveAiActionDto {
  @ApiPropertyOptional({ description: 'Tên bảng gõ lại để xác nhận (khi đề xuất có confirm_label)' })
  @IsOptional() @IsString() @MaxLength(200)
  confirm_text?: string;
}

/** Thân PATCH /integrations/ai-actions/settings. */
export class UpdateAiActionSettingsDto {
  @ApiProperty({ description: 'true ⇒ AI chỉ tạo đề xuất chờ duyệt; false (mặc định) ⇒ AI ghi thẳng theo quyền người dùng' })
  @IsBoolean()
  require_approval!: boolean;
}
