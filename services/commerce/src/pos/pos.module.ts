import { Module } from '@nestjs/common';
import { PosCatalogController } from './pos-catalog.controller';
import { PosCatalogService } from './pos-catalog.service';
import { PosLayoutController } from './pos-layout.controller';
import { PosLayoutService } from './pos-layout.service';
import { PosOrderItemsBuilder } from './pos-order-items.builder';
import { PosOrdersController } from './pos-orders.controller';
import { PosOrdersService } from './pos-orders.service';
import { PosQrService } from './pos-qr.service';
import { PosReportsService } from './pos-reports.service';
import { PosShiftsController } from './pos-shifts.controller';
import { PosShiftsService } from './pos-shifts.service';

/** POS bán hàng tại quầy. Không cron/job. */
@Module({
  controllers: [PosCatalogController, PosLayoutController, PosShiftsController, PosOrdersController],
  providers: [
    PosCatalogService, PosLayoutService, PosShiftsService, PosOrdersService,
    PosOrderItemsBuilder, PosQrService, PosReportsService,
  ],
})
export class PosModule {}
