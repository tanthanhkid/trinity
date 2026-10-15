import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  INTEGRATION_AUDIT_STATUSES,
  INTEGRATION_CHANNELS,
  type IntegrationAuditStatus,
  type IntegrationChannel,
} from '@trinity/prisma';

const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

export class QueryAuditLogsDto {
  @ApiPropertyOptional({ enum: INTEGRATION_CHANNELS })
  @IsOptional()
  @IsIn([...INTEGRATION_CHANNELS])
  channel?: IntegrationChannel;

  @ApiPropertyOptional({ enum: INTEGRATION_AUDIT_STATUSES })
  @IsOptional()
  @IsIn([...INTEGRATION_AUDIT_STATUSES])
  status?: IntegrationAuditStatus;

  @ApiPropertyOptional({ description: 'Lọc theo user (id)' })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  user_id?: number;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'Từ thời điểm (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31T23:59:59.999Z', description: 'Đến thời điểm (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Cursor trả về ở trang trước (`next_cursor`)' })
  @IsOptional()
  @Matches(/^\d{1,15}\.\d{1,19}$/, { message: 'cursor không hợp lệ' })
  cursor?: string;

  @ApiPropertyOptional({ example: 50, description: 'Số dòng mỗi trang (1-100, mặc định 50)' })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
