import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { CustomObjectsModule } from '../custom-objects/custom-objects.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ExtensionRunLog } from './extension-run-log';
import { ExtensionsController } from './extensions.controller';
import { ExtensionsDataPort } from './extensions-data.port';
import { ExtensionsRuntime } from './extensions.runtime';
import { ExtensionsService } from './extensions.service';

/** Chương trình con (agent của khách tự mở rộng hệ thống), chạy cách ly trên Deno. Mặc định TẮT: `EXTENSIONS_ENABLED=true` để bật. */
@Module({
  imports: [PrismaModule, NotificationsModule, CustomObjectsModule],
  controllers: [ExtensionsController],
  providers: [ExtensionsService, ExtensionsRuntime, ExtensionRunLog, ExtensionsDataPort],
  exports: [ExtensionsService, ExtensionsRuntime],
})
export class ExtensionsModule {}
