import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateKanbanFieldDefDto } from './create-field-def.dto';

/**
 * `key`/`type` KHÔNG sửa được sau khi tạo — đổi `key` phá liên kết với
 * `KanbanCard.attributes` JSON đã lưu; đổi `type` khiến giá trị cũ sai kiểu
 * ngay lập tức (mirror `UpdateProductDto` khoá `code`/`project_id`). Cần đổi
 * thì xoá field cũ (giá trị cũ trên card giữ nguyên, không hiển thị nữa) rồi
 * tạo field mới.
 */
export class UpdateKanbanFieldDefDto extends PartialType(
  OmitType(CreateKanbanFieldDefDto, ['key', 'type'] as const),
  { skipNullProperties: false },
) {}
