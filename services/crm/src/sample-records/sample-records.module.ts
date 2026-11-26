import { Global, Module } from '@nestjs/common';
import { SampleRecordsService } from './sample-records.service';

/** Bản ghi mẫu của hệ thống mới dựng — Global để các chỗ tạo khách / bản ghi gọi dọn mẫu mà không kéo vòng import. */
@Global()
@Module({ providers: [SampleRecordsService], exports: [SampleRecordsService] })
export class SampleRecordsModule {}
