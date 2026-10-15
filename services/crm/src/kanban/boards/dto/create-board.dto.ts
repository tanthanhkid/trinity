import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateKanbanBoardDto {
  @ApiProperty({ example: 'Bán hàng' })
  @IsString({ message: 'name phải là chuỗi' })
  @MinLength(1, { message: 'name không được rỗng' })
  @MaxLength(255, { message: 'name tối đa 255 ký tự' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString({ message: 'description phải là chuỗi' })
  @MaxLength(2000, { message: 'description tối đa 2000 ký tự' })
  description?: string | null;

  @ApiPropertyOptional({ example: 'kanban', nullable: true })
  @IsOptional()
  @IsString({ message: 'icon phải là chuỗi' })
  @MaxLength(64, { message: 'icon tối đa 64 ký tự' })
  icon?: string | null;

  @ApiPropertyOptional({ example: '#00753c', nullable: true })
  @IsOptional()
  @IsString({ message: 'color phải là chuỗi' })
  @MaxLength(32, { message: 'color tối đa 32 ký tự' })
  color?: string | null;

  @ApiPropertyOptional({
    description: 'ID vai trò nào THẤY board này. Rỗng/không gửi = mọi vai trò thấy.',
    example: [1, 2],
  })
  @IsOptional()
  @IsArray({ message: 'visibility_role_ids phải là mảng' })
  @ArrayMaxSize(200, { message: 'visibility_role_ids có quá nhiều phần tử' })
  @IsInt({ each: true, message: 'visibility_role_ids chỉ chứa số nguyên' })
  @Min(1, { each: true, message: 'visibility_role_ids phải là id hợp lệ' })
  visibility_role_ids?: number[];

  @ApiPropertyOptional({ example: 'CV-', nullable: true })
  @IsOptional()
  @IsString({ message: 'card_prefix phải là chuỗi' })
  @MaxLength(16, { message: 'card_prefix tối đa 16 ký tự' })
  card_prefix?: string | null;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject({ message: 'settings phải là object' })
  settings?: Record<string, unknown>;
}
