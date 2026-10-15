import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsDateString, IsInt, Min, Matches } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * query params cho endpoint tổng quan Marketing theo tài khoản
 * (recruitment-overview). marketing_user_id chỉ có hiệu lực khi owner (quyền
 * `reports.channels`) là 'all' hoặc chứa đúng id đó — xem
 * `resolveMarketingReportScopeIds` (RBAC quyền + phạm vi).
 */
export class QueryMarketingAccountReportDto {
  @ApiPropertyOptional({
    example: '2026-06-01',
    description: 'Ngày bắt đầu (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString({}, { message: 'date_from không hợp lệ' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_from phải đúng định dạng YYYY-MM-DD' })
  date_from?: string;

  @ApiPropertyOptional({
    example: '2026-06-30',
    description: 'Ngày kết thúc (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString({}, { message: 'date_to không hợp lệ' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_to phải đúng định dạng YYYY-MM-DD' })
  date_to?: string;

  @ApiPropertyOptional({
    description: 'Narrow xuống 1 marketing user cụ thể (chỉ người có quyền xem toàn bộ)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  marketing_user_id?: number;
}
