import { Module } from '@nestjs/common';
import { KanbanBoardsController } from './boards/kanban-boards.controller';
import { KanbanBoardsService } from './boards/kanban-boards.service';
import { KanbanColumnsController } from './columns/kanban-columns.controller';
import { KanbanColumnsService } from './columns/kanban-columns.service';
import { KanbanFieldDefsController } from './field-defs/kanban-field-defs.controller';
import { KanbanFieldDefsService } from './field-defs/kanban-field-defs.service';
import { KanbanCardsController } from './cards/kanban-cards.controller';
import { KanbanCardsService } from './cards/kanban-cards.service';
import { KanbanCardMoveService } from './cards/kanban-card-move.service';
import { KanbanCardActivitiesService } from './cards/kanban-card-activities.service';
import { KanbanChecklistController } from './checklist/kanban-checklist.controller';
import { KanbanChecklistService } from './checklist/kanban-checklist.service';
import { KanbanAttachmentsController } from './attachments/kanban-attachments.controller';
import { CustomObjectsModule } from '../custom-objects/custom-objects.module';
import { KanbanAttachmentsService } from './attachments/kanban-attachments.service';

/**
 * Kanban — bảng công việc đa board tuỳ biến (nâng cấp cảm giác
 * Trello ở). `PrismaService` là Global provider (`PrismaModule` ở
 * `AppModule`) nên KHÔNG cần import lại ở đây.
 */
@Module({
  imports: [CustomObjectsModule],
  controllers: [
    KanbanBoardsController,
    KanbanColumnsController,
    KanbanFieldDefsController,
    KanbanCardsController,
    KanbanChecklistController,
    KanbanAttachmentsController,
  ],
  providers: [
    KanbanBoardsService,
    KanbanColumnsService,
    KanbanFieldDefsService,
    KanbanCardsService,
    KanbanCardMoveService,
    KanbanCardActivitiesService,
    KanbanChecklistService,
    KanbanAttachmentsService,
  ],
  // MCP chỉ đọc dùng lại service đọc card (không dựng logic phạm vi thứ hai).
  exports: [KanbanCardsService],
})
export class KanbanModule {}
