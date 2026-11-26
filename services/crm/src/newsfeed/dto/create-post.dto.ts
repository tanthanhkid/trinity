import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
