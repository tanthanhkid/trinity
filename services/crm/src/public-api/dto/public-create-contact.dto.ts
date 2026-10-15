import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * DTO tạo contact qua API key (public). Tối giản — chỉ các field cốt lõi
 * (SĐT, tên, nguồn). Contact được gán cho `owner_user_id` của API key
 * (không cho bên thứ 3 chỉ định assigned_to tuỳ ý).
 *
 * `source_id` nên là option thuộc group `contact_source`, có thể seed sẵn
 * "Bên thứ 3" để người tích hợp chọn.
 */
export class PublicCreateContactDto {
  @ApiProperty({ example: '0900000001', description: 'SĐT khách hàng' })
  @IsNotEmpty({ message: 'SĐT không được để trống' })
  @IsString()
  @Matches(/^(0|\+84)\d{9}$/, {
    message: 'SĐT không hợp lệ. VD: 0900000001 hoặc +84900000001',
  })
  phone!: string;

  @ApiProperty({ example: 'Nguyễn Văn A', description: 'Họ và tên' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Họ tên không được để trống' })
  @Length(1, 100)
  full_name!: string;

  @ApiProperty({
    example: 3,
    description:
      'ID SettingOption group_key=contact_source. Có thể seed "third_party" cho bên thứ 3.',
  })
  @Type(() => Number)
  @IsInt({ message: 'source_id phải là số nguyên' })
  source_id!: number;

  @ApiPropertyOptional({ example: 'user@example.com' })
  @IsOptional()
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string;

  @ApiPropertyOptional({ example: 'Nhân viên văn phòng' })
  @IsOptional()
  @IsString()
  job_title?: string;

  @ApiPropertyOptional({
    example: 'Landing page campaign 04/2026',
    description: 'Ghi chú tự do',
  })
  @IsOptional()
  @IsString()
  reminder_notes?: string;
}
