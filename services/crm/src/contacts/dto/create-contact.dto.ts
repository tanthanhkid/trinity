import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsInt,
  IsDateString,
  IsIn,
  IsEmail,
  Matches,
  Length,
  IsPositive,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

const VALID_GENDERS = ['nam', 'nu'] as const;

/**
 * bỏ `status` / `sub_status` enum, thay bằng FK SettingOption.
 * `source_id` BẮT BUỘC — map về `SettingOption.group_key='contact_source'`.
 * `stage_id` tuỳ chọn — mặc định service tự set value='new'.
 */
export class CreateContactDto {
  @ApiProperty({
    example: '0900000001',
    description: 'Số điện thoại (bắt buộc). Trùng với khách cùng người phụ trách sẽ bị từ chối (409).',
  })
  @IsNotEmpty({ message: 'SĐT không được để trống' })
  @IsString()
  @Matches(/^(0|\+84)\d{9}$/, {
    message: 'SĐT không hợp lệ. VD: 0900000001 hoặc +84900000001',
  })
  phone!: string;

  @ApiPropertyOptional({
    example: '0987654321',
    description: 'Số điện thoại 2 (dự phòng, tuỳ chọn). Cùng định dạng phone chính.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(0|\+84)\d{9}$/, {
    message: 'SĐT 2 không hợp lệ. VD: 0987654321 hoặc +84987654321',
  })
  phone_2?: string;

  @ApiPropertyOptional({
    example: 'nguyenvana.zalo',
    description: 'Tài khoản Zalo của khách (tuỳ chọn, tối đa 100 ký tự).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100, { message: 'Tài khoản zalo phải từ 1 đến 100 ký tự' })
  zalo_account?: string;

  @ApiProperty({ example: 'Nguyễn Văn A', description: 'Họ và tên (bắt buộc)' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Họ tên không được để trống' })
  @Length(1, 100, { message: 'Họ tên phải từ 1 đến 100 ký tự' })
  full_name!: string;

  @ApiProperty({
    example: 3,
    description:
      'ID SettingOption group_key=contact_source (bắt buộc, LOCK sau khi tạo).',
  })
  @Type(() => Number)
  @IsNotEmpty({ message: 'Vui lòng chọn nguồn' })
  @IsInt({ message: 'source_id phải là số nguyên' })
  source_id!: number;

  @ApiPropertyOptional({
    example: 1,
    description:
      'ID SettingOption group_key=contact_stage. Mặc định "new".',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  stage_id?: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'ID SettingOption group_key=contact_detail_status.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  contact_status_id?: number;

  @ApiPropertyOptional({ example: 'Nhân viên văn phòng' })
  @IsOptional()
  @IsString()
  job_title?: string;

  @ApiPropertyOptional({ example: '1990-05-15', description: 'Ngày sinh' })
  @IsOptional()
  @IsDateString({}, { message: 'Ngày sinh không hợp lệ' })
  birthday?: string;

  @ApiPropertyOptional({ example: 'nam', enum: VALID_GENDERS })
  @IsOptional()
  @IsString()
  @IsIn([...VALID_GENDERS], { message: 'Giới tính không hợp lệ' })
  gender?: string;

  @ApiPropertyOptional({ example: '123 Example Street, District 1' })
  @IsOptional()
  @IsString()
  current_address?: string;

  @ApiPropertyOptional({ example: 'Công ty ABC' })
  @IsOptional()
  @IsString()
  company_name?: string;

  @ApiPropertyOptional({ example: 'user@example.com' })
  @IsOptional()
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string;

  @ApiPropertyOptional({ example: '2026-06-01T09:00:00Z' })
  @IsOptional()
  @IsDateString({}, { message: 'Ngày hẹn không hợp lệ' })
  reminder_at?: string;

  @ApiPropertyOptional({ example: 'Liên hệ lại sáng mai' })
  @IsOptional()
  @IsString()
  reminder_notes?: string;

  @ApiPropertyOptional({
    example: 12,
    description:
      'Sale được gán thương vụ tạo cùng contact.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deal_assigned_to phải là số nguyên' })
  @IsPositive({ message: 'deal_assigned_to phải là số dương' })
  deal_assigned_to?: number;

  @ApiPropertyOptional({
    example: 'https://zalo-cdn.com/avatar/xxxx.jpg',
    description: 'URL avatar khách từ Zalo CDN',
  })
  @IsOptional()
  @IsString()
  avatar_url?: string;
}
