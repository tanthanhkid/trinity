import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { PaymentsService } from './payments.service';

/** Connector cổng thanh toán (SePay, VNPay, MoMo) + yêu cầu thanh toán tự khớp. Cờ tổ chức `payments`. */
@Module({
  imports: [PrismaModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService, PaymentsService],
  exports: [ConnectorsService, PaymentsService],
})
export class ConnectorsModule {}
