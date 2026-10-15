import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** 1 lựa chọn của type=select|multiselect — mirror shape `AttributeOption` (validator). */
export class AttributeOptionDto {
  @ApiProperty({ example: 's' })
  @IsString({ message: 'value phải là chuỗi' })
  @MinLength(1, { message: 'value không được rỗng' })
  @MaxLength(64, { message: 'value tối đa 64 ký tự' })
  value!: string;

  @ApiProperty({ example: 'Nhỏ' })
  @IsString({ message: 'label phải là chuỗi' })
  @MinLength(1, { message: 'label không được rỗng' })
  @MaxLength(255, { message: 'label tối đa 255 ký tự' })
  label!: string;
}
