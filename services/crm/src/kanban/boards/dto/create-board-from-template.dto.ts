import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { KANBAN_TEMPLATES } from '../../common/kanban-templates';

const TEMPLATE_KEYS = KANBAN_TEMPLATES.map((t) => t.key);

export class CreateKanbanBoardFromTemplateDto {
  @ApiProperty({ example: 'sales', enum: TEMPLATE_KEYS })
  @IsString({ message: 'template_key phải là chuỗi' })
  @IsIn(TEMPLATE_KEYS, { message: 'template_key không hợp lệ' })
  template_key!: string;

  @ApiPropertyOptional({ description: 'Ghi đè tên board — mặc định lấy tên mẫu.' })
  @IsOptional()
  @IsString({ message: 'name phải là chuỗi' })
  @MinLength(1, { message: 'name không được rỗng' })
  @MaxLength(255, { message: 'name tối đa 255 ký tự' })
  name?: string;
}
