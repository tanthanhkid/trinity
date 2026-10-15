import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsString, IsOptional, IsNotEmpty } from 'class-validator';

/** chuyển quyền phụ trách 1 liên hệ (Danh bạ) cho sale khác. */
export class TransferContactDto {
  @ApiProperty({
    example: 5,
    description: 'User ID của sale mới được gán',
  })
  @IsNotEmpty({ message: 'new_assigned_to không được để trống' })
  @IsInt({ message: 'new_assigned_to phải là số nguyên' })
  new_assigned_to!: number;

  @ApiPropertyOptional({
    example: 'Sale cũ nghỉ việc, chuyển cho sale mới',
    description: 'Lý do chuyển liên hệ',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
