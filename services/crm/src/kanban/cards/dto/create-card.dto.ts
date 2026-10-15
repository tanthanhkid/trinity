import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  KANBAN_CARD_ASSIGNEES_MAX,
  KANBAN_CARD_DESCRIPTION_MAX_LENGTH,
  KANBAN_CARD_TITLE_MAX_LENGTH,
  KANBAN_LABEL_MAX_ITEMS,
  KANBAN_LABEL_MAX_LENGTH,
  KANBAN_PRIORITIES,
} from '../../common/kanban.constants';

const INT4_MAX = 2_147_483_647;

export class CreateKanbanCardDto {
  @ApiProperty({ description: 'Cột đích trong board.' })
  @Type(() => Number)
  @IsInt({ message: 'column_id phải là số nguyên' })
  @Min(1, { message: 'column_id không hợp lệ' })
  column_id!: number;

  @ApiProperty({ example: 'Liên hệ lại khách hàng A' })
  @IsString({ message: 'title phải là chuỗi' })
  @MinLength(1, { message: 'title không được rỗng' })
  @MaxLength(KANBAN_CARD_TITLE_MAX_LENGTH, {
    message: `title tối đa ${KANBAN_CARD_TITLE_MAX_LENGTH} ký tự`,
  })
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString({ message: 'description phải là chuỗi' })
  @MaxLength(KANBAN_CARD_DESCRIPTION_MAX_LENGTH, {
    message: `description tối đa ${KANBAN_CARD_DESCRIPTION_MAX_LENGTH} ký tự`,
  })
  description?: string | null;

  @ApiPropertyOptional({ description: 'Khách hàng gắn với card (contacts.id) — tối đa 1.', nullable: true })
  @IsOptional()
  @IsInt({ message: 'contact_id phải là số nguyên' })
  @Min(1, { message: 'contact_id không hợp lệ' })
  @Max(INT4_MAX, { message: 'contact_id vượt trần cho phép' })
  contact_id?: number | null;

  @ApiPropertyOptional({ description: 'Người phụ trách CHÍNH (tương thích ngược) — v1 chỉ 1 người.', nullable: true })
  @IsOptional()
  @IsInt({ message: 'assignee_id phải là số nguyên' })
  @Min(1, { message: 'assignee_id không hợp lệ' })
  @Max(INT4_MAX, { message: 'assignee_id vượt trần cho phép' })
  assignee_id?: number | null;

  @ApiPropertyOptional({
    description:
      'Toàn bộ danh sách người phụ trách (THAY THẾ hoàn toàn khi gửi — kể cả rỗng). Gửi field này thì BỎ QUA assignee_id (phần tử đầu = primary).',
    example: [12, 34],
  })
  @IsOptional()
  @IsArray({ message: 'assignee_ids phải là mảng' })
  @ArrayMaxSize(KANBAN_CARD_ASSIGNEES_MAX, {
    message: `assignee_ids tối đa ${KANBAN_CARD_ASSIGNEES_MAX} người`,
  })
  @Type(() => Number)
  @IsInt({ each: true, message: 'assignee_ids chỉ chứa số nguyên' })
  assignee_ids?: number[];

  @ApiPropertyOptional({ description: 'Hạn xử lý (ISO 8601).', nullable: true })
  @IsOptional()
  @IsDateString({}, { message: 'due_at phải là ngày ISO 8601 hợp lệ' })
  due_at?: string | null;

  @ApiPropertyOptional({ enum: KANBAN_PRIORITIES, nullable: true })
  @IsOptional()
  @IsIn(KANBAN_PRIORITIES, { message: 'priority không hợp lệ' })
  priority?: string | null;

  @ApiPropertyOptional({ example: ['gấp', 'VIP'] })
  @IsOptional()
  @IsArray({ message: 'labels phải là mảng' })
  @ArrayMaxSize(KANBAN_LABEL_MAX_ITEMS, { message: `labels tối đa ${KANBAN_LABEL_MAX_ITEMS} phần tử` })
  @IsString({ each: true, message: 'labels chỉ chứa chuỗi' })
  @MaxLength(KANBAN_LABEL_MAX_LENGTH, { each: true, message: `mỗi label tối đa ${KANBAN_LABEL_MAX_LENGTH} ký tự` })
  labels?: string[];

  @ApiPropertyOptional({
    type: 'object',
    description: 'Giá trị trường tuỳ biến theo `KanbanFieldDef` của board.',
  })
  @IsOptional()
  @IsObject({ message: 'attributes phải là object' })
  attributes?: Record<string, unknown>;
}
