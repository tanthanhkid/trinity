import { Body, Controller, Delete, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Can } from '@trinity/rbac-nest';
import { KanbanFieldDefsService } from './kanban-field-defs.service';
import { CreateKanbanFieldDefDto } from './dto/create-field-def.dto';
import { UpdateKanbanFieldDefDto } from './dto/update-field-def.dto';
import { ReorderKanbanFieldDefsDto } from './dto/reorder-field-defs.dto';

/** Cấu hình trường tuỳ biến — quyền `kanban.boards`. */
@ApiTags('Kanban Field Defs')
@ApiBearerAuth()
@Can('kanban.boards')
@Controller('kanban')
export class KanbanFieldDefsController {
  constructor(private readonly fieldDefsService: KanbanFieldDefsService) {}

  @Post('boards/:boardId/field-defs')
  @ApiOperation({ summary: 'Tạo trường tuỳ biến mới cho board' })
  create(@Param('boardId', ParseIntPipe) boardId: number, @Body() dto: CreateKanbanFieldDefDto) {
    return this.fieldDefsService.create(boardId, dto);
  }

  @Post('boards/:boardId/field-defs/reorder')
  @ApiOperation({ summary: 'Sắp xếp lại thứ tự trường tuỳ biến của board' })
  reorder(
    @Param('boardId', ParseIntPipe) boardId: number,
    @Body() dto: ReorderKanbanFieldDefsDto,
  ) {
    return this.fieldDefsService.reorder(boardId, dto);
  }

  @Patch('field-defs/:id')
  @ApiOperation({ summary: 'Sửa trường tuỳ biến (label/options/required/show_on_card)' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateKanbanFieldDefDto) {
    return this.fieldDefsService.update(id, dto);
  }

  @Delete('field-defs/:id')
  @ApiOperation({ summary: 'Xoá trường tuỳ biến — giá trị đã lưu trên card giữ nguyên' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.fieldDefsService.remove(id);
  }
}
