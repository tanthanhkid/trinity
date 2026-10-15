import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/** 3 mốc N ngày cho phép chọn — khớp UI (7/14/30 ngày). */
export const UNCONTACTED_DAY_OPTIONS = [7, 14, 30] as const;

export class QueryReportUncontactedDto {
  @ApiPropertyOptional({ enum: UNCONTACTED_DAY_OPTIONS, default: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsIn(UNCONTACTED_DAY_OPTIONS as unknown as number[])
  days?: (typeof UNCONTACTED_DAY_OPTIONS)[number];

  @ApiPropertyOptional({ description: 'Cursor phân trang — id contact cuối cùng đã thấy' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cursor?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
