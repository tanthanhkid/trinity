import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { PublicApiModule } from '../public-api/public-api.module';
import { CommerceSyncService } from './commerce-sync.service';
import { KiotVietService } from './kiotviet.service';
import { SapoService } from './sapo.service';
import { MisaService } from './misa.service';
import { WooCommerceService } from './woocommerce.service';
import { ShopeeService } from './shopee.service';
import { LazadaService } from './lazada.service';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { PaymentsService } from './payments.service';

/** Connector dịch vụ ngoài (SePay → VNPay, MoMo, KiotViet…) + yêu cầu thanh toán tự khớp. Cờ tổ chức `payments`. */
@Module({
  imports: [PrismaModule, PublicApiModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService, PaymentsService, CommerceSyncService, KiotVietService, SapoService, MisaService, WooCommerceService, ShopeeService, LazadaService],
  exports: [ConnectorsService, PaymentsService, CommerceSyncService],
})
export class ConnectorsModule {}
