import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * `ValidationPipe` toàn cục KHÔNG bật `enableImplicitConversion` — query param
 * luôn tới dưới dạng string, PHẢI `@Type(() => Number)` tường minh.
 */
export class DeleteKanbanColumnQueryDto {
  @ApiPropertyOptional({
    description: 'Cột đích để dồn card sang — BẮT BUỘC nếu cột đang xoá còn card.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'move_to_column_id phải là số nguyên' })
  @Min(1, { message: 'move_to_column_id không hợp lệ' })
  move_to_column_id?: number;
}
