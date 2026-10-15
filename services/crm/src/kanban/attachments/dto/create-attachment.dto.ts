import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import {
  KANBAN_ATTACHMENT_TITLE_MAX_LENGTH,
  KANBAN_ATTACHMENT_URL_MAX_LENGTH,
} from '../../common/kanban.constants';

/**
 * Đính kèm DẠNG LINK — nhận URL, KHÔNG upload file. `IsUrl` yêu cầu `http`/`https`
 * tường minh (KHÔNG nhận `javascript:`/`data:` — mirror gate href RichTextEditor
 * đã có ở Newsfeed).
 */
export class CreateKanbanAttachmentDto {
  @ApiProperty({ example: 'https://drive.google.com/file/d/...' })
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'url phải là đường dẫn http/https hợp lệ' },
  )
  @MaxLength(KANBAN_ATTACHMENT_URL_MAX_LENGTH, {
    message: `url tối đa ${KANBAN_ATTACHMENT_URL_MAX_LENGTH} ký tự`,
  })
  url!: string;

  @ApiPropertyOptional({ example: 'Hợp đồng bản scan' })
  @IsOptional()
  @IsString({ message: 'title phải là chuỗi' })
  @MaxLength(KANBAN_ATTACHMENT_TITLE_MAX_LENGTH, {
    message: `title tối đa ${KANBAN_ATTACHMENT_TITLE_MAX_LENGTH} ký tự`,
  })
  title?: string;
}
