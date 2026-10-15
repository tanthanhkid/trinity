import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayMaxSize, IsArray, IsInt } from 'class-validator';
import { KANBAN_REORDER_MAX_ITEMS } from '../../common/kanban.constants';

export class ReorderKanbanColumnsDto {
  @ApiProperty({
    description: 'ID TẤT CẢ cột (chưa archive) của board, theo THỨ TỰ MỚI mong muốn.',
    example: [3, 1, 2],
  })
  @IsArray({ message: 'column_ids phải là mảng' })
  @ArrayMinSize(1, { message: 'column_ids không được rỗng' })
  @ArrayMaxSize(KANBAN_REORDER_MAX_ITEMS, { message: `column_ids tối đa ${KANBAN_REORDER_MAX_ITEMS} phần tử` })
  @IsInt({ each: true, message: 'column_ids chỉ chứa số nguyên' })
  column_ids!: number[];
}
