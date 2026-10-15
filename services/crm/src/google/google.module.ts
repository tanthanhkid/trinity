import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { CustomObjectsModule } from '../custom-objects/custom-objects.module';
import { PublicApiModule } from '../public-api/public-api.module';
import { GoogleController } from './google.controller';
import { GoogleFeatureService } from './google-feature.service';
import { GoogleHttp } from './google-http';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleSheetsApi } from './google-sheets-api';
import { GoogleSyncScheduler } from './google-sync.scheduler';
import { GoogleSyncService } from './google-sync.service';
import { SheetExportService } from './sheet-export.service';
import { SheetImportContacts } from './sheet-import-contacts';
import { SheetImportCustom } from './sheet-import-custom';

/** Kết nối Google Sheet hai chiều. Cờ tổ chức `google_sheets`; env GOOGLE_OAUTH_CLIENT_ID/SECRET (thiếu = không hoạt động). */
@Module({
  imports: [PrismaModule, PublicApiModule, CustomObjectsModule],
  controllers: [GoogleController],
  providers: [GoogleHttp, GoogleOAuthService, GoogleSheetsApi, GoogleFeatureService, GoogleSyncService, GoogleSyncScheduler, SheetExportService, SheetImportContacts, SheetImportCustom],
})
export class GoogleModule {}
