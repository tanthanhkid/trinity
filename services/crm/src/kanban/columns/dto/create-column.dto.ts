import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { KANBAN_BOARD_LABEL_COLOR_PATTERN } from '../../common/kanban.constants';

export class CreateKanbanColumnDto {
  @ApiProperty({ example: 'Mới' })
  @IsString({ message: 'name phải là chuỗi' })
  @MinLength(1, { message: 'name không được rỗng' })
  @MaxLength(255, { message: 'name tối đa 255 ký tự' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString({ message: 'color phải là chuỗi' })
  @MaxLength(32, { message: 'color tối đa 32 ký tự' })
  @Matches(KANBAN_BOARD_LABEL_COLOR_PATTERN, { message: 'color phải là mã hex hợp lệ (vd #198754)' })
  color?: string | null;

  @ApiPropertyOptional({ description: 'Chỉ cảnh báo khi vượt — KHÔNG chặn tạo/chuyển card.', nullable: true })
  @IsOptional()
  @IsInt({ message: 'wip_limit phải là số nguyên' })
  @Min(1, { message: 'wip_limit tối thiểu 1' })
  @Max(10_000, { message: 'wip_limit vượt trần cho phép' })
  wip_limit?: number | null;

  @ApiPropertyOptional({ description: 'Đánh dấu cột "Hoàn thành" — card chuyển vào cột này được set completed_at.' })
  @IsOptional()
  @IsBoolean({ message: 'is_done phải là boolean' })
  is_done?: boolean;
}
