import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Đồng bộ CONTENT_MAX_LENGTH với create-post.dto.ts — content nay co the la
// HTML rich-text (RichTextEditor), ton nhieu ky tu hon plain text.
export class UpdatePostDto {
  @ApiProperty({ description: 'Nội dung bài đăng (rich text HTML hoặc plain text)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  content!: string;
}
