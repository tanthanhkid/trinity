import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@trinity/prisma';
import { Can, CurrentUser, ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadKanbanAccessContext } from '../common/kanban-rbac.helper';
import { KanbanAttachmentsService } from './kanban-attachments.service';
import { CreateKanbanAttachmentDto } from './dto/create-attachment.dto';

/** Đính kèm dạng link của card — RBAC ROW-LEVEL qua gate card cha. */
@ApiTags('Kanban Attachments')
@ApiBearerAuth()
@Controller('kanban')
export class KanbanAttachmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly attachmentsService: KanbanAttachmentsService,
  ) {}

  @Get('cards/:cardId/attachments')
  @Can('kanban.view')
  @ApiOperation({ summary: 'Danh sách đính kèm (link) của card' })
  async list(@Param('cardId', ParseIntPipe) cardId: number, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.attachmentsService.list(user, access, cardId);
  }

  @Post('cards/:cardId/attachments')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Thêm đính kèm dạng link (chưa hỗ trợ upload file)' })
  async create(
    @Param('cardId', ParseIntPipe) cardId: number,
    @Body() dto: CreateKanbanAttachmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.attachmentsService.create(user, access, cardId, dto);
  }

  @Delete('attachments/:id')
  @Can('kanban.manage')
  @ApiOperation({ summary: 'Xoá 1 đính kèm' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const access = await loadKanbanAccessContext(this.prisma, this.scope, user);
    return this.attachmentsService.remove(user, access, id);
  }
}
