import { Module } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import { CustomObjectTemplatesService } from './custom-object-templates.service';
import { CustomObjectsController } from './custom-objects.controller';
import { CustomObjectsService } from './custom-objects.service';
import { CustomRecordsController } from './custom-records.controller';
import { CustomRecordsExportService } from './custom-records-export.service';
import { CustomRecordsListService } from './custom-records-list.service';
import { CustomRecordsService } from './custom-records.service';
import { RecordPresenter } from './record-presenter.service';
import { RecordValidator } from './record-validator.service';
import { CustomViewsService } from './custom-views.service';
import { CustomMenuService } from './custom-menu.service';
import { SchemaVersionsService } from './schema-versions.service';
import { RecordRefsController } from './refs/record-refs.controller';
import { RecordRefsService } from './refs/record-refs.service';
import { RecordLinksService } from './refs/record-links.service';
import { RefPreviewService } from './refs/ref-preview.service';

/**
 * Thực thể tuỳ biến: người dùng tự thêm “tính năng” (Học sinh, Hoá đơn…) hiện trên menu.
 * `PrismaService` là Global; `ScopeService` do `RbacModule` cung cấp.
 */
@Module({
  controllers: [CustomObjectsController, CustomRecordsController, RecordRefsController],
  providers: [
    CustomObjectsService, CustomFieldsService, CustomRecordsService, CustomRecordsListService,
    CustomRecordsExportService, CustomObjectTemplatesService, RecordPresenter, RecordValidator, CustomViewsService, CustomMenuService, SchemaVersionsService,
    RecordRefsService, RecordLinksService, RefPreviewService,
  ],
  // MCP dùng lại đúng các service này (đọc/ghi/validate bản ghi) — không viết lại logic quyền.
  exports: [CustomRecordsService, CustomRecordsListService, RecordValidator, CustomObjectsService, CustomFieldsService, CustomObjectTemplatesService, CustomViewsService, CustomMenuService, SchemaVersionsService, RecordRefsService, RecordLinksService],
})
export class CustomObjectsModule {}
