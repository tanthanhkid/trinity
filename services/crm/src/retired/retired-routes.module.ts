import { Module } from '@nestjs/common';
import { RetiredRoutesController } from './retired-routes.controller';

/** Đường công khai của tính năng đã gỡ — chỉ trả 410, không đọc/ghi gì. */
@Module({ controllers: [RetiredRoutesController] })
export class RetiredRoutesModule {}
