import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { KANBAN_CHECKLIST_ITEM_TEXT_MAX_LENGTH } from '../../common/kanban.constants';

export class CreateKanbanChecklistItemDto {
  @ApiProperty({ example: 'Gọi xác nhận lịch hẹn' })
  @IsString({ message: 'text phải là chuỗi' })
  @MinLength(1, { message: 'text không được rỗng' })
  @MaxLength(KANBAN_CHECKLIST_ITEM_TEXT_MAX_LENGTH, {
    message: `text tối đa ${KANBAN_CHECKLIST_ITEM_TEXT_MAX_LENGTH} ký tự`,
  })
  text!: string;
}
