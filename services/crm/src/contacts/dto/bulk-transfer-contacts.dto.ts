import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { CONTACT_BULK_TRANSFER_MAX } from '../contact-transfer.service';

/** chuyển quyền phụ trách NHIỀU liên hệ cùng lúc (vd sale nghỉ việc). */
export class BulkTransferContactsDto {
  @ApiProperty({
    type: [Number],
    example: [1, 2, 3],
    description: `Danh sách ID khách hàng cần chuyển, tối đa ${CONTACT_BULK_TRANSFER_MAX} khách hàng/lần`,
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'contact_ids không được để trống' })
  @ArrayMaxSize(CONTACT_BULK_TRANSFER_MAX, {
    message: `Tối đa ${CONTACT_BULK_TRANSFER_MAX} khách hàng mỗi lần chuyển`,
  })
  @IsInt({ each: true, message: 'contact_ids phải là mảng số nguyên' })
  contact_ids!: number[];

  @ApiProperty({
    example: 5,
    description: 'User ID của sale mới được gán',
  })
  @IsNotEmpty({ message: 'new_assigned_to không được để trống' })
  @IsInt({ message: 'new_assigned_to phải là số nguyên' })
  new_assigned_to!: number;

  @ApiPropertyOptional({
    example: 'Sale cũ nghỉ việc, chuyển cho sale mới',
    description: 'Lý do chuyển khách hàng',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
