import { ApiProperty } from '@nestjs/swagger';
import { Matches, MaxLength, MinLength } from 'class-validator';
import {
  KANBAN_BOARD_LABEL_COLOR_PATTERN,
  KANBAN_BOARD_LABEL_NAME_MAX_LENGTH,
} from '../../common/kanban.constants';

export class CreateKanbanLabelDto {
  @ApiProperty({ example: 'Gấp' })
  @MinLength(1, { message: 'name không được rỗng' })
  @MaxLength(KANBAN_BOARD_LABEL_NAME_MAX_LENGTH, {
    message: `name tối đa ${KANBAN_BOARD_LABEL_NAME_MAX_LENGTH} ký tự`,
  })
  name!: string;

  @ApiProperty({ example: '#eb5a46', description: 'Mã màu hex #abc hoặc #aabbcc.' })
  @Matches(KANBAN_BOARD_LABEL_COLOR_PATTERN, { message: 'color phải là mã hex hợp lệ (vd #eb5a46)' })
  color!: string;
}
