import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, ValidateIf } from 'class-validator';
import { CreateKanbanColumnDto } from './create-column.dto';

const isDefined = (_obj: unknown, value: unknown): boolean => value !== undefined;

export class UpdateKanbanColumnDto extends PartialType(CreateKanbanColumnDto, {
  skipNullProperties: false,
}) {
  @ApiPropertyOptional({ description: 'Ẩn cột khỏi board (giữ lại card/lịch sử) — KHÔNG dùng để xoá.' })
  @ValidateIf(isDefined)
  @IsBoolean({ message: 'is_archived phải là boolean' })
  is_archived?: boolean;
}
