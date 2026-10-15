import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@trinity/prisma';
import { Can, CurrentUser, ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadKanbanAccessContext } from '../common/kanban-rbac.helper';
import { KanbanCardsService } from './kanban-cards.service';
import { KanbanCardMoveService } from './kanban-card-move.service';
import { KanbanCardActivitiesService } from './kanban-card-activities.service';
import { CreateKanbanCardDto } from './dto/create-card.dto';
import { UpdateKanbanCardDto } from './dto/update-card.dto';
import { MoveKanbanCardDto } from './dto/move-card.dto';
import { QueryKanbanCardsDto } from './dto/query-cards.dto';
import { CreateKanbanCommentDto } from './dto/create-comment.dto';

/**
 * `kanban.view` cho đọc, `kanban.manage` cho ghi — RBAC ở đây CÒN là ROW-LEVEL
 * (xem `kanban-rbac.helper.ts`). `access` (owner id + role id theo phạm vi)
 * preload 1 lần/request rồi truyền xuống service, KHÔNG query lại nhiều lần
 * trong cùng request.
 */
@ApiTags('Kanban Cards')
@ApiBearerAuth()
@Controller('kanban/cards')
export class KanbanCardsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly cardsService: KanbanCardsService,
    private readonly moveService: KanbanCardMoveService,
    private readonly activitiesService: KanbanCardActivitiesService,
  ) {}

  @Get()
  @Can('kanban.view')
  @ApiOperation({
    summary:
      'Danh sách card — lọc theo board/cột/khách hàng/người phụ trách/nhãn/quá hạn/tìm kiếm, cursor phân trang',
  })
  async list(@Query() query: QueryKanbanCardsDto, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.cardsService.list(user, access, query);
  }

  @Get(':id')
  @Can('kanban.view')
  @ApiResponse({ status: 404, description: 'Không tồn tại hoặc ngoài phạm vi' })
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.cardsService.findOne(user, access, id);
  }

  @Post()
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Tạo card mới' })
  async create(@Body() dto: CreateKanbanCardDto, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.cardsService.create(user, access, dto);
  }

  @Patch(':id')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Sửa card (tiêu đề/mô tả/khách hàng/người phụ trách/hạn/nhãn/field tuỳ biến)' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateKanbanCardDto,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.cardsService.update(user, access, id, dto);
  }

  @Post(':id/move')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Kéo thả — chuyển cột và/hoặc đổi vị trí trong cột' })
  async move(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MoveKanbanCardDto,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.moveService.move(user, access, id, dto);
  }

  @Delete(':id')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Xoá mềm card — người tạo hoặc Quản trị' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.cardsService.remove(user, access, id);
  }

  @Get(':id/activities')
  @Can('kanban.view')
  @ApiOperation({ summary: 'Lịch sử card (tạo/chuyển cột/sửa/bình luận)' })
  async listActivities(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.activitiesService.listActivities(user, access, id);
  }

  @Post(':id/comments')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Bình luận trên card (ghi vào lịch sử, action=comment)' })
  async addComment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateKanbanCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.activitiesService.addComment(user, access, id, dto);
  }
}
