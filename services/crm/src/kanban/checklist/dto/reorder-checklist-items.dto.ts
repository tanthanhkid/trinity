import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt } from 'class-validator';
import { KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD } from '../../common/kanban.constants';

export class ReorderKanbanChecklistItemsDto {
  @ApiProperty({ type: [Number], description: 'ĐỦ và ĐÚNG id các item chưa xoá của card, theo thứ tự mới.' })
  @IsArray({ message: 'item_ids phải là mảng' })
  @ArrayMinSize(1, { message: 'item_ids không được rỗng' })
  @ArrayMaxSize(KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD, {
    message: `item_ids tối đa ${KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD} phần tử`,
  })
  @Type(() => Number)
  @IsInt({ each: true, message: 'item_ids chỉ chứa số nguyên' })
  item_ids!: number[];
}
