import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export const NEWSFEED_CATEGORIES = ['announcement', 'training', 'pr'] as const;
export type NewsfeedCategory = (typeof NEWSFEED_CATEGORIES)[number];

// Content nay co the la HTML rich-text (RichTextEditor) thay vi plain text
// thuan — HTML ton nhieu ky tu hon (the + style inline) nen nang gioi han len.
const CONTENT_MAX_LENGTH = 20000;

export class CreatePostDto {
  @ApiProperty({ enum: NEWSFEED_CATEGORIES })
  @IsIn(NEWSFEED_CATEGORIES as unknown as string[])
  category!: NewsfeedCategory;

  @ApiProperty({ description: 'Nội dung bài đăng (rich text HTML hoặc plain text)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTENT_MAX_LENGTH)
  content!: string;
}

export class CreatePostMultipartDto {
  @ApiProperty({ enum: NEWSFEED_CATEGORIES })
  @IsIn(NEWSFEED_CATEGORIES as unknown as string[])
  category!: NewsfeedCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(CONTENT_MAX_LENGTH)
  content?: string;

  @ApiPropertyOptional({
    description:
      'Khoá video đã upload thẳng lên Blob, phân tách bằng dấu phẩy — lấy từ POST newsfeed/video-upload-token',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  video_keys?: string;
}

export class VideoUploadTokenDto {
  @ApiProperty({ description: 'Tên file gốc (chỉ dùng lấy đuôi .mp4/.webm/.mov)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name!: string;

  @ApiProperty({ description: 'Dung lượng video (byte)' })
  @IsInt()
  @Min(1)
  size!: number;
}
