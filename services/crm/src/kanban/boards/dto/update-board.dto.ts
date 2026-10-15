import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, ValidateIf } from 'class-validator';
import { CreateKanbanBoardDto } from './create-board.dto';

const isDefined = (_obj: unknown, value: unknown): boolean => value !== undefined;

/**
 * `skipNullProperties: false` (mirror `UpdateProductDto`): field kế thừa dùng
 * `ValidateIf(v => v !== undefined)` thay `IsOptional()` — `null` chạy validator
 * gốc cho cột NOT NULL (`name`), vẫn nhận `null` để "xoá giá trị" cho cột
 * nullable (`description`, `icon`, `color`, `card_prefix`).
 */
export class UpdateKanbanBoardDto extends PartialType(CreateKanbanBoardDto, {
  skipNullProperties: false,
}) {
  @ApiPropertyOptional({ example: true, description: 'Bật/tắt board (mirror `products.is_active`).' })
  @ValidateIf(isDefined)
  @IsBoolean({ message: 'is_active phải là boolean' })
  is_active?: boolean;
}
