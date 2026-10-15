import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { KANBAN_CHECKLIST_ITEM_TEXT_MAX_LENGTH } from '../../common/kanban.constants';

export class UpdateKanbanChecklistItemDto {
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsString({ message: 'text phải là chuỗi' })
  @MinLength(1, { message: 'text không được rỗng' })
  @MaxLength(KANBAN_CHECKLIST_ITEM_TEXT_MAX_LENGTH, {
    message: `text tối đa ${KANBAN_CHECKLIST_ITEM_TEXT_MAX_LENGTH} ký tự`,
  })
  text?: string;

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean({ message: 'is_done phải là boolean' })
  is_done?: boolean;
}
