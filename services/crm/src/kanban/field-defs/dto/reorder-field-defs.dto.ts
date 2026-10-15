import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayMaxSize, IsArray, IsInt } from 'class-validator';
import { KANBAN_REORDER_MAX_ITEMS } from '../../common/kanban.constants';

export class ReorderKanbanFieldDefsDto {
  @ApiProperty({ description: 'ID TẤT CẢ field def của board, theo THỨ TỰ MỚI mong muốn.' })
  @IsArray({ message: 'field_def_ids phải là mảng' })
  @ArrayMinSize(1, { message: 'field_def_ids không được rỗng' })
  @ArrayMaxSize(KANBAN_REORDER_MAX_ITEMS, {
    message: `field_def_ids tối đa ${KANBAN_REORDER_MAX_ITEMS} phần tử`,
  })
  @IsInt({ each: true, message: 'field_def_ids chỉ chứa số nguyên' })
  field_def_ids!: number[];
}
