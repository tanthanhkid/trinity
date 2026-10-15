import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { INTEGRATION_EVENT_TYPES } from '@trinity/prisma';

const toInt = ({ value }: { value: unknown }) => (value === undefined || value === '' ? undefined : Number(value));
export const DELIVERY_STATUSES = ['pending', 'success', 'failed', 'dead'] as const;

export class QueryWebhookDeliveriesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  endpoint_id?: number;

  @ApiPropertyOptional({ enum: DELIVERY_STATUSES })
  @IsOptional()
  @IsIn([...DELIVERY_STATUSES])
  status?: (typeof DELIVERY_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Loại sự kiện (hoặc "ping")' })
  @IsOptional()
  @IsString()
  @IsIn([...INTEGRATION_EVENT_TYPES, 'ping'])
  event_type?: string;

  @ApiPropertyOptional({ description: 'Cursor "<epochMs>.<uuid>" từ meta.next_cursor' })
  @IsOptional()
  @Matches(/^\d{1,15}\.[0-9a-f-]{36}$/, { message: 'cursor không hợp lệ' })
  cursor?: string;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
