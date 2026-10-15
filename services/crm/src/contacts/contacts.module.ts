import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { ContactsExportService } from './contacts-export.service';
import { ContactTransferService } from './contact-transfer.service';
import { ContactRecentViewsService } from './contact-recent-views.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CustomObjectsModule } from '../custom-objects/custom-objects.module';
import { ActivitiesModule } from '../activities/activities.module';

@Module({
  imports: [AuditModule, NotificationsModule, ActivitiesModule, CustomObjectsModule],
  controllers: [ContactsController],
  providers: [
    ContactsService,
    ContactsExportService,
    ContactTransferService,
    ContactRecentViewsService,
  ],
  // duyệt đề xuất AI "chuyển khách" chạy qua ĐÚNG ContactTransferService (không dựng logic phạm vi thứ hai).
  exports: [ContactsService, ContactTransferService],
})
export class ContactsModule {}
