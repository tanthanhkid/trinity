import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Vị trí đích xác định bằng 2 LÁNG GIỀNG hiện có trong cột đích (theo thứ tự
 * FE đang render) — KHÔNG nhận `position` số thực trực tiếp từ client (tránh
 * client tự tính sai/đụng độ). BE tính `position` mới bằng fractional-indexing
 * (`computeBetweenPosition`), renormalize khi cần.
 */
export class MoveKanbanCardDto {
  @ApiProperty({ description: 'Cột đích.' })
  @IsInt({ message: 'column_id phải là số nguyên' })
  @Min(1, { message: 'column_id không hợp lệ' })
  column_id!: number;

  @ApiPropertyOptional({ description: 'Card đứng NGAY TRƯỚC vị trí đích trong cột đích (nếu có).' })
  @IsOptional()
  @IsInt({ message: 'before_card_id phải là số nguyên' })
  @Min(1, { message: 'before_card_id không hợp lệ' })
  before_card_id?: number;

  @ApiPropertyOptional({ description: 'Card đứng NGAY SAU vị trí đích trong cột đích (nếu có).' })
  @IsOptional()
  @IsInt({ message: 'after_card_id phải là số nguyên' })
  @Min(1, { message: 'after_card_id không hợp lệ' })
  after_card_id?: number;
}
