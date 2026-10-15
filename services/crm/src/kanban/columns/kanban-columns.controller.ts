import {
  Body,
  Controller,
  Delete,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { KanbanColumnsService } from './kanban-columns.service';
import { CreateKanbanColumnDto } from './dto/create-column.dto';
import { UpdateKanbanColumnDto } from './dto/update-column.dto';
import { ReorderKanbanColumnsDto } from './dto/reorder-columns.dto';
import { DeleteKanbanColumnQueryDto } from './dto/delete-column-query.dto';

/** Cấu hình cột — quyền `kanban.boards`. */
@ApiTags('Kanban Columns')
@ApiBearerAuth()
@Can('kanban.boards')
@Controller('kanban')
export class KanbanColumnsController {
  constructor(private readonly columnsService: KanbanColumnsService) {}

  @Post('boards/:boardId/columns')
  @ApiOperation({ summary: 'Tạo cột mới (thêm vào cuối board)' })
  create(@Param('boardId', ParseIntPipe) boardId: number, @Body() dto: CreateKanbanColumnDto) {
    return this.columnsService.create(boardId, dto);
  }

  @Post('boards/:boardId/columns/reorder')
  @ApiOperation({ summary: 'Sắp xếp lại thứ tự cột của board' })
  reorder(
    @Param('boardId', ParseIntPipe) boardId: number,
    @Body() dto: ReorderKanbanColumnsDto,
  ) {
    return this.columnsService.reorder(boardId, dto);
  }

  @Patch('columns/:id')
  @ApiOperation({ summary: 'Sửa cột (tên/màu/WIP/đánh dấu Hoàn thành/ẩn)' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateKanbanColumnDto) {
    return this.columnsService.update(id, dto);
  }

  @Delete('columns/:id')
  @ApiOperation({ summary: 'Xoá cột — bắt buộc move_to_column_id nếu còn card' })
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: DeleteKanbanColumnQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.columnsService.remove(id, query.move_to_column_id, user.userId);
  }
}
