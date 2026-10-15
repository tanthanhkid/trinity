import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import { EMPLOYMENT_STATUSES } from './query-contracts.dto';

// bộ lọc cho dialog "Thống kê hợp đồng". Tất cả optional: KHÔNG gửi gì
// = giữ nguyên hành vi hiện tại (toàn bộ nhân viên, không lọc ngày).
export class QueryContractStatsDto {
  @ApiPropertyOptional({ description: 'Lọc HĐ ký từ ngày (ISODate, theo signed_date)' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiPropertyOptional({ description: 'Lọc HĐ ký đến ngày (ISODate, theo signed_date)' })
  @IsOptional()
  @IsDateString()
  date_to?: string;

  @ApiPropertyOptional({ description: 'Lọc theo bộ phận' })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({ description: 'Lọc theo team (team_lead user id, dạng string)' })
  @IsOptional()
  @IsString()
  team?: string;

  @ApiPropertyOptional({ description: 'Lọc theo tình trạng làm việc', enum: EMPLOYMENT_STATUSES })
  @IsOptional()
  @IsIn(EMPLOYMENT_STATUSES)
  employment_status?: string;
}
