import { PartialType } from '@nestjs/swagger';
import { CreateKanbanLabelDto } from './create-label.dto';

// skipNullProperties:false — `null` phải bị validator chặn (400), không lọt xuống `.trim()`/cột NOT NULL.
export class UpdateKanbanLabelDto extends PartialType(CreateKanbanLabelDto, {
  skipNullProperties: false,
}) {}
