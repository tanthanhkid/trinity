import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** 1 lựa chọn của field type=select|multi_select. */
export class KanbanFieldOptionDto {
  @ApiProperty({ example: 'high' })
  @IsString({ message: 'value phải là chuỗi' })
  @MinLength(1, { message: 'value không được rỗng' })
  @MaxLength(64, { message: 'value tối đa 64 ký tự' })
  value!: string;

  @ApiProperty({ example: 'Cao' })
  @IsString({ message: 'label phải là chuỗi' })
  @MinLength(1, { message: 'label không được rỗng' })
  @MaxLength(255, { message: 'label tối đa 255 ký tự' })
  label!: string;
}
