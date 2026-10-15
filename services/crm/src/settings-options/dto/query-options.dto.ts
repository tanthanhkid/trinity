import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query params cho `GET /settings/options`.
 */
export class QueryOptionsDto {
  @ApiPropertyOptional({
    example: 'contact_source',
    description: 'Lọc theo nhóm (bắt buộc khi gọi từ UI dropdown)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,49}$/, {
    message: 'group_key chỉ chứa a-z, 0-9, _ và bắt đầu bằng chữ thường',
  })
  group?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Nếu true: chỉ trả rows is_active=true. Default true.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    const v = String(value).toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'no') return false;
    return undefined;
  })
  @IsBoolean()
  active?: boolean;
}
