import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { ConnectorsModule } from '../connectors/connectors.module';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';

/** Trang bán hàng online nhanh — dùng chung khung connector (ghép khách, yêu cầu thanh toán SePay). */
@Module({
  imports: [PrismaModule, ConnectorsModule],
  controllers: [StoreController],
  providers: [StoreService],
  exports: [StoreService],
})
export class StoreModule {}
