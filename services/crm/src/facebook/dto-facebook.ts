import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class UpdateFacebookPageDto {
  @ApiPropertyOptional({ description: 'Sale nhận khách từ Lead Ads' })
  @ValidateIf((_o, v) => v !== undefined) @IsInt() default_assignee_id?: number;

  @ApiPropertyOptional({ description: 'setting_options.id thuộc group contact_source' })
  @ValidateIf((_o, v) => v !== undefined) @IsInt() contact_source_id?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() is_active?: boolean;
}

export class FacebookReplyDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString({ message: 'Nội dung phải là chuỗi' }) @MinLength(1, { message: 'Nội dung trống' }) @MaxLength(2000, { message: 'Tin nhắn tối đa 2000 ký tự' })
  text!: string;
}

export class CommentReplyDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString({ message: 'Nội dung phải là chuỗi' }) @MinLength(1, { message: 'Nội dung trống' }) @MaxLength(2000, { message: 'Trả lời tối đa 2000 ký tự' })
  text!: string;

  @ApiProperty({ enum: ['public', 'private'], description: 'public = trả lời dưới bình luận; private = nhắn riêng qua Messenger' })
  @IsIn(['public', 'private'], { message: 'Cách trả lời phải là public hoặc private' })
  mode!: 'public' | 'private';
}

const TEXT_LIST = { each: true, message: 'Mỗi mục tối đa 2000 ký tự' };

/** Luật tự xử lý bình luận. Tạo: bắt buộc `name`; sửa: mọi trường tuỳ chọn. */
export class CommentRuleDto {
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional({ description: 'null = mọi Page' }) @IsOptional() @IsString() @MaxLength(40) page_id?: string | null;
  @ApiPropertyOptional({ description: 'Link hoặc id bài; null = mọi bài' }) @IsOptional() @IsString() @MaxLength(500) post_id?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(200, { each: true }) keywords?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(200, { each: true }) exclude_keywords?: string[];
  @ApiPropertyOptional({ type: [String], description: 'Chọn ngẫu nhiên một câu; {ten} = tên người bình luận' }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(2000, TEXT_LIST) public_replies?: string[];
  @ApiPropertyOptional({ maxLength: 2000 }) @IsOptional() @IsString() @MaxLength(2000) private_reply?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hide_if_phone?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() once_per_user?: boolean;
  @ApiPropertyOptional({ enum: ['test', 'live'] }) @IsOptional() @IsIn(['test', 'live']) mode?: 'test' | 'live';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() is_active?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
}

export class CommentDryRunDto {
  @ApiProperty({ maxLength: 5000 }) @IsString() @MinLength(1, { message: 'Nhập bình luận mẫu' }) @MaxLength(5000) message!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) page_id?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) post_id?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) from_name?: string | null;
}

/** Link/QR mở chat Messenger kèm nguồn khách. Tạo: bắt buộc `name`, `page_id`; sửa: mọi trường tuỳ chọn (không đổi Page). */
export class ChatLinkDto {
  @ApiPropertyOptional({ maxLength: 120, description: 'Tên để phân biệt, vd "Tờ rơi quán", "QR bàn 5"' }) @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional({ description: 'page_id của Fanpage đã kết nối (chỉ khi tạo)' }) @IsOptional() @IsString() @MaxLength(40) page_id?: string;
  @ApiPropertyOptional({ description: 'setting_options.id nhóm contact_source; null = nguồn mặc định của Page' })
  @ValidateIf((_o, v) => v !== undefined && v !== null) @IsInt() source_id?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() is_active?: boolean;
}

/** Kịch bản nhắn tin nhiều bước. Tạo: bắt buộc `name`, `page_id`, `trigger`, `steps`; sửa: mọi trường tuỳ chọn (không đổi Page). Bước kiểm ở service. */
export class FlowDto {
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional({ description: 'page_id của Fanpage đã kết nối (chỉ khi tạo)' }) @IsOptional() @IsString() @MaxLength(40) page_id?: string;
  @ApiPropertyOptional({ enum: ['keyword', 'chat_link', 'first_message'] }) @IsOptional() @IsIn(['keyword', 'chat_link', 'first_message']) trigger?: 'keyword' | 'chat_link' | 'first_message';
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(100, { each: true }) keywords?: string[];
  @ApiPropertyOptional({ description: 'Link/QR mở chat (khi trigger=chat_link)' }) @ValidateIf((_o, v) => v !== undefined && v !== null) @IsInt() chat_link_id?: number | null;
  @ApiPropertyOptional({ description: 'Danh sách bước: { id, text, wait_minutes?, buttons?: [{ title, next }], ask?: phone|email|note, next? }' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) steps?: unknown[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() is_active?: boolean;
}

/** Lọc người nhận gửi hàng loạt. */
export class BroadcastAudienceDto {
  @ApiPropertyOptional({ type: [Number], description: 'Chỉ khách thuộc các nguồn này' }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsInt({ each: true }) source_ids?: number[];
  @ApiPropertyOptional({ type: [Number], description: 'Chỉ khách vào chat qua các link/QR này' }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsInt({ each: true }) chat_link_ids?: number[];
}

/** Gửi tin hàng loạt. Tạo: bắt buộc `name`, `page_id`, `text`; sửa: mọi trường tuỳ chọn. */
export class BroadcastDto {
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) page_id?: string;
  @ApiPropertyOptional({ description: 'Nội dung; {ten} = tên khách', maxLength: 2000 }) @IsOptional() @IsString() @MaxLength(2000) text?: string;
  @ApiPropertyOptional({ type: BroadcastAudienceDto }) @IsOptional() audience?: BroadcastAudienceDto;
}

export class BroadcastPreviewDto {
  @ApiProperty() @IsString() @MaxLength(40) page_id!: string;
  @ApiPropertyOptional({ type: BroadcastAudienceDto }) @IsOptional() audience?: BroadcastAudienceDto;
}

export class BroadcastSendDto {
  @ApiPropertyOptional({ description: 'ISO 8601; bỏ trống = gửi ngay (tối đa 7 ngày tới)' }) @IsOptional() @IsString() @MaxLength(40) scheduled_at?: string | null;
}
