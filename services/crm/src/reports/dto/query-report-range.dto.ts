import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, Matches } from 'class-validator';

/**
 * Khoảng thời gian báo cáo — BẮT BUỘC cả 2 field (FE `DateRangeFilter` luôn
 * gửi đủ, mặc định "hôm nay"). Dùng chung cho Tổng quan/Khách hàng/Hiệu suất
 * nhân viên.
 */
export class QueryReportRangeDto {
  @ApiProperty({ example: '2026-09-01', description: 'Ngày bắt đầu (YYYY-MM-DD, giờ VN)' })
  @IsNotEmpty({ message: 'date_from là bắt buộc' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_from phải đúng định dạng YYYY-MM-DD' })
  date_from!: string;

  @ApiProperty({ example: '2026-09-26', description: 'Ngày kết thúc (YYYY-MM-DD, giờ VN)' })
  @IsNotEmpty({ message: 'date_to là bắt buộc' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_to phải đúng định dạng YYYY-MM-DD' })
  date_to!: string;
}
