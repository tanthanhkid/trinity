import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { KANBAN_CARDS_DEFAULT_LIMIT, KANBAN_CARDS_MAX_LIMIT } from '../../common/kanban.constants';

/**
 * `ValidationPipe` toàn cục KHÔNG bật `enableImplicitConversion` — mọi param
 * PHẢI `@Type`/`@Transform` tường minh (mirror `ListProductsQueryDto`).
 */
export class QueryKanbanCardsDto {
  @ApiPropertyOptional({ description: 'Giới hạn theo 1 board. Bỏ trống = tìm xuyên board (vd tab "Công việc" của khách hàng).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'board_id phải là số nguyên' })
  @Min(1, { message: 'board_id không hợp lệ' })
  board_id?: number;

  @ApiPropertyOptional({ description: 'Giới hạn theo 1 cột — dùng cho tải theo cột + "tải thêm".' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'column_id phải là số nguyên' })
  @Min(1, { message: 'column_id không hợp lệ' })
  column_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'contact_id phải là số nguyên' })
  @Min(1, { message: 'contact_id không hợp lệ' })
  contact_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'assignee_id phải là số nguyên' })
  @Min(1, { message: 'assignee_id không hợp lệ' })
  assignee_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'label phải là chuỗi' })
  @MaxLength(64, { message: 'label tối đa 64 ký tự' })
  label?: string;

  @ApiPropertyOptional({ description: 'true = chỉ card quá hạn (due_at < now, chưa hoàn thành).' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean({ message: 'overdue phải là true hoặc false' })
  overdue?: boolean;

  @ApiPropertyOptional({ description: 'Tìm theo tiêu đề (không phân biệt hoa/thường).' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'search phải là chuỗi' })
  @MaxLength(255, { message: 'search tối đa 255 ký tự' })
  search?: string;

  @ApiPropertyOptional({ description: 'Cursor phân trang — id nhỏ nhất của trang trước.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'cursor phải là số nguyên' })
  cursor?: number;

  @ApiPropertyOptional({ default: KANBAN_CARDS_DEFAULT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit phải là số nguyên' })
  @Min(1, { message: 'limit tối thiểu 1' })
  @Max(KANBAN_CARDS_MAX_LIMIT, { message: `limit tối đa ${KANBAN_CARDS_MAX_LIMIT}` })
  limit?: number;
}
