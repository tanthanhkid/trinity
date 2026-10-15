import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SOCIAL_NETWORKS } from './social.config';

export class SocialConnectDto {
  @ApiProperty({ enum: SOCIAL_NETWORKS })
  @IsIn(SOCIAL_NETWORKS as unknown as string[], { message: 'Mạng không hợp lệ' })
  network!: (typeof SOCIAL_NETWORKS)[number];
}

export class SocialUploadTokenDto {
  @ApiProperty() @IsString() @MaxLength(255) file_name!: string;
  @ApiProperty() @IsInt() @Min(1) size!: number;
}

export class SocialMediaRegisterDto {
  @ApiProperty() @IsString() @MaxLength(200) key!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) name?: string;
}

export class SocialTargetDto {
  @ApiProperty({ description: 'id kênh (GET social/accounts)' }) @IsInt() @Min(1) account_id!: number;
  @ApiPropertyOptional({ description: 'Nội dung riêng cho kênh này; bỏ trống = dùng nội dung chung' })
  @IsOptional() @IsString() @MaxLength(70_000) caption?: string | null;
  @ApiPropertyOptional({ description: 'Tuỳ chọn riêng của mạng, vd Facebook video {title}' })
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}

export class SocialUtmDto {
  @ApiProperty({ description: 'Tên chiến dịch (utm_campaign) 1–100 ký tự; khoảng trắng → "-"' }) @IsString() @Length(1, 100) campaign!: string;
  @ApiPropertyOptional({ description: 'utm_content (tối đa 100 ký tự)' }) @IsOptional() @IsString() @MaxLength(100) content?: string;
}

export class CreateSocialPostDto {
  @ApiProperty({ description: 'Nội dung chung' }) @IsString() @MaxLength(70_000) content!: string;

  @ApiPropertyOptional({ type: [String], description: 'Khoá tệp từ POST social/media hoặc social/media/upload-token' })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(200, { each: true }) media_keys?: string[];

  @ApiProperty({ type: [SocialTargetDto] })
  @IsArray() @ArrayMinSize(1, { message: 'Chọn ít nhất một kênh' }) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => SocialTargetDto)
  targets!: SocialTargetDto[];

  @ApiPropertyOptional({ description: 'Giờ hẹn ISO 8601; bỏ trống = đăng ngay' })
  @IsOptional() @IsISO8601({}, { message: 'scheduled_at phải là ISO 8601' }) scheduled_at?: string | null;

  @ApiPropertyOptional({ description: 'Đặt vào khung trống gần nhất của hàng đợi (thay cho scheduled_at)' })
  @IsOptional() @IsBoolean() use_queue?: boolean;

  @ApiPropertyOptional({ type: SocialUtmDto, nullable: true, description: 'Gắn UTM vào mọi liên kết http(s) khi đăng: utm_source = tên mạng, utm_medium = social, utm_campaign, utm_content. Liên kết đã có utm_ giữ nguyên.' })
  @IsOptional() @ValidateNested() @Type(() => SocialUtmDto) utm?: SocialUtmDto | null;
}

export class GoogleReviewReplyDto {
  @ApiProperty({ example: 'Cảm ơn anh đã ghé quán!', description: 'Câu trả lời công khai (tối đa 4.096 byte)' })
  @IsString()
  @Length(1, 4096)
  comment!: string;
}

export class SocialRescheduleDto {
  @ApiProperty({ example: '2026-10-20T09:00:00+07:00', description: 'Giờ hẹn mới (ISO 8601)' })
  @IsISO8601({}, { message: 'scheduled_at phải là ISO 8601' })
  scheduled_at!: string;
}

export class SocialDraftMediaDto {
  @ApiProperty() @IsString() @MaxLength(200) key!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
}

export class SocialDraftDto {
  @ApiPropertyOptional({ description: 'Tên gợi nhớ của nháp' }) @IsOptional() @IsString() @MaxLength(120) title?: string | null;
  @ApiPropertyOptional({ description: 'Nội dung chung (có thể trống)' }) @IsOptional() @IsString() @MaxLength(63_206) content?: string;
  @ApiPropertyOptional({ type: [SocialDraftMediaDto], description: 'Tệp từ thư viện media kèm tên hiển thị' })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => SocialDraftMediaDto) media?: SocialDraftMediaDto[];
  @ApiPropertyOptional({ type: [SocialTargetDto], description: 'Kênh đã chọn (có thể trống)' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => SocialTargetDto) targets?: SocialTargetDto[];
  @ApiPropertyOptional({ description: 'Giờ hẹn ISO 8601 hoặc null' })
  @IsOptional() @IsISO8601({}, { message: 'scheduled_at phải là ISO 8601' }) scheduled_at?: string | null;
  @ApiPropertyOptional({ description: 'Đăng vào khung trống gần nhất của hàng đợi (thay cho scheduled_at)' })
  @IsOptional() @IsBoolean() use_queue?: boolean;
  @ApiPropertyOptional({ type: SocialUtmDto, nullable: true, description: 'Gắn UTM khi đăng (lưu vào tuỳ chọn từng kênh của nháp); null = bỏ' })
  @IsOptional() @ValidateNested() @Type(() => SocialUtmDto) utm?: SocialUtmDto | null;
  @ApiPropertyOptional({ description: 'Trạng thái ô soạn của web để mở lại đúng như cũ (máy chủ không đọc)' })
  @IsOptional() @IsObject() ui?: Record<string, unknown> | null;
}

export class SocialDraftPublishDto {
  @ApiPropertyOptional({ description: 'Đổi giờ hẹn khi đăng (ISO 8601); null = đăng ngay; bỏ trống = giữ giờ của nháp' })
  @IsOptional() @IsISO8601({}, { message: 'scheduled_at phải là ISO 8601' }) scheduled_at?: string | null;

  @ApiPropertyOptional({ description: 'updated_at của nháp người dùng đang xem; nháp đã đổi sau đó ⇒ 409, không đăng' })
  @IsOptional() @IsISO8601({}, { message: 'expected_updated_at phải là ISO 8601' }) expected_updated_at?: string;

  @ApiPropertyOptional({ description: 'Đặt vào khung trống gần nhất của hàng đợi (thay cho giờ hẹn)' })
  @IsOptional() @IsBoolean() use_queue?: boolean;
}

export class SocialQueueSlotDto {
  @ApiProperty({ description: '0 = Chủ nhật … 6 = Thứ bảy (giờ Việt Nam)' }) @IsInt() @Min(0) @Max(6) weekday!: number;
  @ApiProperty({ description: 'Số phút từ 00:00 giờ Việt Nam (0–1439)' }) @IsInt() @Min(0) @Max(1439) minute!: number;
}

export class SocialQueueSlotsDto {
  @ApiProperty({ type: [SocialQueueSlotDto], description: 'Thay toàn bộ khung giờ (tối đa 100)' })
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SocialQueueSlotDto) slots!: SocialQueueSlotDto[];
}

export class SocialSnippetDto {
  @ApiPropertyOptional({ enum: ['hashtags', 'signature'], description: 'Bắt buộc khi tạo; không đổi được khi sửa' })
  @IsOptional() @IsIn(['hashtags', 'signature'], { message: 'Loại mẫu phải là hashtags hoặc signature' }) kind?: 'hashtags' | 'signature';
  @ApiPropertyOptional({ description: 'Tên mẫu 1–80 ký tự' }) @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional({ description: 'Nội dung 1–2000 ký tự; bộ hashtag được chuẩn hoá (thêm #, bỏ trùng)' }) @IsOptional() @IsString() @MaxLength(10_000) content?: string;
  @ApiPropertyOptional({ description: 'Chữ ký mặc định (tự điền vào bài mới ở web); chỉ dành cho chữ ký' }) @IsOptional() @IsBoolean() is_default?: boolean;
}

export class SocialImportPlanDto {
  @ApiProperty({ description: 'Nội dung CSV (UTF-8; dấu phẩy hoặc chấm phẩy; tối đa 1 MB, 200 dòng)' }) @IsString() @MaxLength(1_100_000) csv!: string;
  @ApiProperty({ enum: ['drafts', 'schedule'], description: 'drafts = tạo nháp; schedule = tạo bài hẹn giờ (mọi dòng cần giờ hoặc "hàng đợi")' })
  @IsIn(['drafts', 'schedule'], { message: 'mode phải là drafts hoặc schedule' }) mode!: 'drafts' | 'schedule';
}

export class SocialImportDto extends SocialImportPlanDto {
  @ApiProperty({ description: 'plan_hash của bản kiểm tra người dùng đã xem; khác bản kiểm lại ⇒ 409' }) @IsString() @Length(64, 64) plan_hash!: string;
}
