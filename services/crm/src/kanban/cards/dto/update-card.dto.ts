import { ApiPropertyOptional } from '@nestjs/swagger';
import { OmitType, PartialType } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { CreateKanbanCardDto } from './create-card.dto';

/**
 * `column_id` KHÔNG nằm trong DTO này — đổi cột đi qua `POST /kanban/cards/:id/move`
 * (transaction riêng, ghi activity `moved`, xử lý `completed_at`).
 *
 * `skipNullProperties: false` (mirror `UpdateProductDto`): `title` (NOT NULL,
 * KHÔNG có `@IsOptional()` gốc) → gửi `null` bị 400 thay vì lọt xuống Prisma
 * thành 500. Các field nullable khác (`description`/`contact_id`/`assignee_id`/
 * `due_at`/`priority`) đã có `@IsOptional()` NGAY TRÊN chính field đó ở
 * `CreateKanbanCardDto` → vẫn nhận `null` = "xoá/gỡ liên kết" (unlink contact,
 * bỏ người phụ trách, xoá hạn, xoá priority).
 */
export class UpdateKanbanCardDto extends PartialType(
  OmitType(CreateKanbanCardDto, ['column_id'] as const),
  { skipNullProperties: false },
) {
  @ApiPropertyOptional({
    description:
      'Đánh dấu hoàn thành HẠN xử lý (ĐỘC LẬP với việc chuyển cột) — ISO 8601 khi đánh dấu, null khi bỏ đánh dấu.',
    nullable: true,
  })
  @IsOptional()
  @IsDateString({}, { message: 'due_completed_at phải là ngày ISO 8601 hợp lệ' })
  due_completed_at?: string | null;
}
