import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsIn, IsInt, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class QueryDealDto {
  @ApiPropertyOptional({ example: 'open', description: 'Lọc theo trạng thái' })
  @IsOptional()
  @IsIn(['open', 'won', 'lost'])
  status?: string;

  @ApiPropertyOptional({ example: 5, description: 'Lọc theo sale được gán' })
  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsInt()
  assigned_to?: number;

  @ApiPropertyOptional({ example: 50, description: 'Cursor-based: ID cuối của trang trước' })
  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsInt()
  cursor?: number;

  @ApiPropertyOptional({ example: 20, description: 'Số bản ghi mỗi trang (max 50)' })
  @IsOptional()
  @Transform(({ value }) => Math.min(Math.max(parseInt(value) || 20, 1), 50))
  @IsInt()
  limit?: number;

  @ApiPropertyOptional({ example: 'Thương vụ', description: 'Tìm kiếm theo tên' })
  @IsOptional()
  @IsString()
  search?: string;
}
