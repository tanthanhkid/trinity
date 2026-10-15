import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@trinity/prisma';
import { Can, CurrentUser, ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadKanbanAccessContext } from '../common/kanban-rbac.helper';
import { KanbanBoardsService } from './kanban-boards.service';
import { CreateKanbanBoardDto } from './dto/create-board.dto';
import { UpdateKanbanBoardDto } from './dto/update-board.dto';
import { CreateKanbanBoardFromTemplateDto } from './dto/create-board-from-template.dto';
import { CreateKanbanLabelDto } from './dto/create-label.dto';
import { UpdateKanbanLabelDto } from './dto/update-label.dto';

/**
 * Cấu hình board (POST/PATCH/DELETE/templates) — quyền `kanban.boards`. Xem
 * board — quyền `kanban.view` (mọi role có quyền công việc), lọc theo
 * `visibility_role_ids` ở tầng service (`buildKanbanBoardVisibilityWhere`/
 * `loadVisibleBoardOrNotFound`).
 */
@ApiTags('Kanban Boards')
@ApiBearerAuth()
@Controller('kanban/boards')
export class KanbanBoardsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly boardsService: KanbanBoardsService,
  ) {}

  @Get()
  @Can('kanban.view')
  @ApiOperation({ summary: 'Danh sách board mà người dùng hiện tại thấy được' })
  async findAll(@CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.boardsService.findAllVisible(user, access);
  }

  @Get('templates')
  @Can('kanban.boards')
  @ApiOperation({ summary: 'Danh sách board mẫu để nhân bản' })
  listTemplates() {
    return this.boardsService.listTemplates();
  }

  @Get(':id')
  @Can('kanban.view')
  @ApiOperation({ summary: 'Chi tiết board + cột + trường tuỳ biến' })
  @ApiResponse({ status: 404, description: 'Không tồn tại hoặc ngoài phạm vi' })
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.boardsService.findOneDetail(user, access, id);
  }

  @Post()
  @Can('kanban.boards')
  @ApiOperation({ summary: 'Tạo board mới' })
  create(@Body() dto: CreateKanbanBoardDto, @CurrentUser() user: AuthUser) {
    return this.boardsService.create(dto, user.userId);
  }

  @Post('from-template')
  @Can('kanban.boards')
  @ApiOperation({ summary: 'Nhân bản board từ mẫu có sẵn' })
  createFromTemplate(
    @Body() dto: CreateKanbanBoardFromTemplateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.boardsService.createFromTemplate(dto, user.userId);
  }

  @Patch(':id')
  @Can('kanban.boards')
  @ApiOperation({ summary: 'Sửa board' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateKanbanBoardDto) {
    return this.boardsService.update(id, dto);
  }

  @Delete(':id')
  @Can('kanban.boards')
  @ApiOperation({ summary: 'Xoá mềm board' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.boardsService.remove(id);
  }

  /**
   * Nhãn màu — CỐ Ý mở cho MỌI người thấy board (`kanban.view`,
   * KHÔNG cần `kanban.boards` như 4 endpoint cấu hình board/cột/field-def phía
   * trên). Đây là tài nguyên cộng tác kiểu Trello (ai cũng có thể thêm nhãn
   * "Gấp"/"VIP" khi làm việc), KHÁC bản chất với cấu hình cấu trúc board —
   * gate thật là board phải HIỂN THỊ với actor (`loadVisibleBoardOrNotFound`
   * trong service, 404 nếu không).
   */
  @Post(':id/labels')
  @Can('kanban.view')
  @ApiOperation({ summary: 'Tạo nhãn màu mới cho board' })
  async createLabel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateKanbanLabelDto,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.boardsService.createLabel(user, access, id, dto);
  }

  @Patch(':id/labels/:labelId')
  @Can('kanban.view')
  @ApiOperation({ summary: 'Sửa tên/màu 1 nhãn' })
  async updateLabel(
    @Param('id', ParseIntPipe) id: number,
    @Param('labelId') labelId: string,
    @Body() dto: UpdateKanbanLabelDto,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.boardsService.updateLabel(user, access, id, labelId, dto);
  }

  @Delete(':id/labels/:labelId')
  @Can('kanban.view')
  @ApiOperation({ summary: 'Xoá nhãn — tự gỡ khỏi mọi card đang gắn' })
  async removeLabel(
    @Param('id', ParseIntPipe) id: number,
    @Param('labelId') labelId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.boardsService.removeLabel(user, access, id, labelId);
  }
}
