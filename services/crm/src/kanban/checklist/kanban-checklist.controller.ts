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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@trinity/prisma';
import { Can, CurrentUser, ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadKanbanAccessContext } from '../common/kanban-rbac.helper';
import { KanbanChecklistService } from './kanban-checklist.service';
import { CreateKanbanChecklistItemDto } from './dto/create-checklist-item.dto';
import { UpdateKanbanChecklistItemDto } from './dto/update-checklist-item.dto';
import { ReorderKanbanChecklistItemsDto } from './dto/reorder-checklist-items.dto';

/** Checklist card — RBAC ROW-LEVEL qua gate card cha (mirror
 * `KanbanCardsController`). */
@ApiTags('Kanban Checklist')
@ApiBearerAuth()
@Controller('kanban')
export class KanbanChecklistController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly checklistService: KanbanChecklistService,
  ) {}

  @Get('cards/:cardId/checklist-items')
  @Can('kanban.view')
  @ApiOperation({ summary: 'Danh sách mục checklist của card' })
  async list(@Param('cardId', ParseIntPipe) cardId: number, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.checklistService.list(user, access, cardId);
  }

  @Post('cards/:cardId/checklist-items')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Thêm mục checklist mới (thêm vào cuối)' })
  async create(
    @Param('cardId', ParseIntPipe) cardId: number,
    @Body() dto: CreateKanbanChecklistItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.checklistService.create(user, access, cardId, dto);
  }

  @Post('cards/:cardId/checklist-items/reorder')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Sắp xếp lại thứ tự các mục checklist' })
  async reorder(
    @Param('cardId', ParseIntPipe) cardId: number,
    @Body() dto: ReorderKanbanChecklistItemsDto,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.checklistService.reorder(user, access, cardId, dto);
  }

  @Patch('checklist-items/:id')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Sửa nội dung hoặc đánh dấu hoàn thành 1 mục' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateKanbanChecklistItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.checklistService.update(user, access, id, dto);
  }

  @Delete('checklist-items/:id')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Xoá 1 mục checklist' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.checklistService.remove(user, access, id);
  }
}
