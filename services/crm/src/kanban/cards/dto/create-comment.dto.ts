import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { KANBAN_COMMENT_MAX_LENGTH } from '../../common/kanban.constants';

export class CreateKanbanCommentDto {
  @ApiProperty({ example: 'Đã gửi báo giá cho khách.' })
  @IsString({ message: 'content phải là chuỗi' })
  @MinLength(1, { message: 'content không được rỗng' })
  @MaxLength(KANBAN_COMMENT_MAX_LENGTH, { message: `content tối đa ${KANBAN_COMMENT_MAX_LENGTH} ký tự` })
  content!: string;
}
