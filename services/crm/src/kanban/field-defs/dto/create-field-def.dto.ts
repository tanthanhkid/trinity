import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { KANBAN_FIELD_TYPES } from '../../common/kanban.constants';
import { KanbanFieldOptionDto } from './kanban-field-option.dto';

export class CreateKanbanFieldDefDto {
  @ApiProperty({
    example: 'muc_do_uu_tien',
    description: 'Khoá kỹ thuật trong `attributes` JSON — chữ thường/số/gạch dưới, KHÔNG đổi được sau khi tạo.',
  })
  @IsString({ message: 'key phải là chuỗi' })
  @Matches(/^[a-z][a-z0-9_]{0,63}$/, {
    message: 'key chỉ chứa chữ thường/số/gạch dưới, bắt đầu bằng chữ, tối đa 64 ký tự',
  })
  key!: string;

  @ApiProperty({ example: 'Mức độ ưu tiên' })
  @IsString({ message: 'label phải là chuỗi' })
  @MaxLength(255, { message: 'label tối đa 255 ký tự' })
  label!: string;

  @ApiProperty({ enum: KANBAN_FIELD_TYPES, example: 'select' })
  @IsIn(KANBAN_FIELD_TYPES, { message: 'type không hợp lệ' })
  type!: string;

  @ApiPropertyOptional({
    type: [KanbanFieldOptionDto],
    description: 'BẮT BUỘC khi type=select|multi_select.',
  })
  @IsOptional()
  @IsArray({ message: 'options phải là mảng' })
  @ArrayMaxSize(100, { message: 'options tối đa 100 phần tử' })
  @ValidateNested({ each: true })
  @Type(() => KanbanFieldOptionDto)
  options?: KanbanFieldOptionDto[];

  @ApiPropertyOptional({ description: 'Bắt buộc nhập khi tạo/sửa card.' })
  @IsOptional()
  @IsBoolean({ message: 'required phải là boolean' })
  required?: boolean;

  @ApiPropertyOptional({ description: 'Hiện trên mặt trước card (view Kanban) thay vì chỉ trong dialog chi tiết.' })
  @IsOptional()
  @IsBoolean({ message: 'show_on_card phải là boolean' })
  show_on_card?: boolean;
}
