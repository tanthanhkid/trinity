import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { PublicApiModule } from '../public-api/public-api.module';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';

/** Trang bán hàng online nhanh — ghép khách qua PublicApiService; chuyển khoản bằng QR VietQR tự sinh (không cổng thanh toán). */
@Module({
  imports: [PrismaModule, PublicApiModule],
  controllers: [StoreController],
  providers: [StoreService],
  exports: [StoreService],
})
export class StoreModule {}
