import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsDateString,
  IsInt,
  IsIn,
  IsEmail,
  Matches,
  IsArray,
  ValidateNested,
  ValidateIf,
  IsUUID,
  Length,
  MaxLength,
  ArrayMaxSize,
  IsObject,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * Skip validation khi value === null. Dùng cho field nullable text/date/enum
 * user clear field trên form gửi null, BE persist null xuống DB.
 * Pattern: @IsOptional() + @ValidateIf(skipIfNull) + @IsString()/@IsEmail()/...
 */
const skipIfNull = (_obj: unknown, value: unknown): boolean => value !== null;
/** Email cho phép null hoặc empty string (clear). */
const skipIfNullOrEmpty = (_obj: unknown, value: unknown): boolean =>
  value !== null && value !== '';

const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'textarea'] as const;
const CUSTOM_FIELD_SECTIONS = ['personal', 'work'] as const;

export class ContactCustomFieldDto {
  @ApiPropertyOptional({ example: '9b4a3b7e-4a2c-4d5e-9b8a-1234567890ab' })
  @IsUUID('4', { message: 'ID trường tuỳ chỉnh không hợp lệ' })
  id!: string;

  @ApiPropertyOptional({ example: 'Sở thích' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 50, { message: 'Tên trường phải từ 1 đến 50 ký tự' })
  label!: string;

  @ApiPropertyOptional({ enum: CUSTOM_FIELD_TYPES })
  @IsIn([...CUSTOM_FIELD_TYPES], { message: 'Kiểu dữ liệu không hợp lệ' })
  type!: (typeof CUSTOM_FIELD_TYPES)[number];

  @ApiPropertyOptional({ example: 'Đá bóng' })
  @IsString()
  @MaxLength(500, { message: 'Giá trị không quá 500 ký tự' })
  value!: string;

  @ApiPropertyOptional({ enum: CUSTOM_FIELD_SECTIONS })
  @IsIn([...CUSTOM_FIELD_SECTIONS], { message: 'Khu vực trường không hợp lệ' })
  section!: (typeof CUSTOM_FIELD_SECTIONS)[number];

  @ApiPropertyOptional({ example: '2026-04-23T10:00:00.000Z' })
  @IsDateString({}, { message: 'Thời gian tạo không hợp lệ' })
  created_at!: string;
}

const VALID_GENDERS = ['nam', 'nu'] as const;

/**
 * `phone` thông thường LOCK sau khi tạo. Ngoại lệ:
 * super_admin được phép update phone qua trường này — service kiểm tra role +
 * duplicate trước khi ghi. `full_name` / `source_id` cho phép BACKFILL-ONLY:
 * service chỉ ghi khi giá trị hiện tại NULL hoặc rỗng (contact legacy hoặc
 * tạo qua script không điền đủ). Nếu contact đã có giá trị hợp lệ, service
 * silently ignore để tránh override data đã confirmed. `status` / `sub_status`
 * enum cũ đã xoá, thay bằng `stage_id` / `contact_status_id`
 * (dropdown SettingOption).
 */
export class UpdateContactDto {
  @ApiPropertyOptional({
    example: '0900000001',
    description:
      'Số điện thoại — cần quyền contacts.phone_full phủ owner của contact, nếu không bị 403. ' +
      'Kiểm tra trùng trước khi ghi (ConflictException nếu SĐT đã tồn tại).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(0|\+84)\d{9}$/, { message: 'SDT không hợp lệ (0xxxxxxxxx hoặc +84xxxxxxxxx)' })
  phone?: string;

  @ApiPropertyOptional({
    example: '0987654321',
    description: 'Số điện thoại 2 (dự phòng). null để xoá.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf(skipIfNull)
  @IsString()
  @Matches(/^(0|\+84)\d{9}$/, {
    message: 'SĐT 2 không hợp lệ (0xxxxxxxxx hoặc +84xxxxxxxxx)',
  })
  phone_2?: string | null;

  @ApiPropertyOptional({
    example: 'nguyenvana.zalo',
    description: 'Tài khoản Zalo của khách. null để xoá.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf(skipIfNull)
  @IsString()
  @Length(1, 100, { message: 'Tài khoản zalo phải từ 1 đến 100 ký tự' })
  zalo_account?: string | null;

  @ApiPropertyOptional({
    example: 'Nguyễn Văn A',
    description:
      'Họ và tên — BACKFILL-ONLY: chỉ ghi khi contact đang rỗng/null.',
  })
  // Không nullable: `null` phải 400 (không lọt xuống `.trim()` trong service).
  @ValidateIf((_o, v) => v !== undefined)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100, { message: 'Họ tên phải từ 1 đến 100 ký tự' })
  full_name?: string;

  @ApiPropertyOptional({
    example: 3,
    description:
      'ID SettingOption group_key=contact_source — BACKFILL-ONLY: chỉ ghi khi contact đang null.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @Type(() => Number)
  @IsInt({ message: 'source_id phải là số nguyên' })
  source_id?: number;

  @ApiPropertyOptional({
    example: 2,
    description: 'ID SettingOption group_key=contact_stage (4 options).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  stage_id?: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'ID SettingOption group_key=contact_detail_status (9 options).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  contact_status_id?: number;

  @ApiPropertyOptional({ example: '2026-04-01T09:00:00Z', nullable: true })
  @IsOptional()
  @ValidateIf(skipIfNull)
  @IsDateString({}, { message: 'Ngày hẹn không hợp lệ' })
  reminder_at?: string | null;

  @ApiPropertyOptional({ example: 'Liên hệ lại lúc 9h', nullable: true })
  @IsOptional()
  @ValidateIf(skipIfNull)
  @IsString()
  reminder_notes?: string | null;

  @ApiPropertyOptional({ example: 'Nhân viên văn phòng', nullable: true })
  @IsOptional()
  @ValidateIf(skipIfNull)
  @IsString()
  job_title?: string | null;

  @ApiPropertyOptional({ example: '1990-05-15', nullable: true })
  @IsOptional()
  @ValidateIf(skipIfNull)
  @IsDateString({}, { message: 'Ngày sinh không hợp lệ' })
  birthday?: string | null;

  @ApiPropertyOptional({
    example: 'nam',
    enum: VALID_GENDERS,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf(skipIfNull)
  @IsString()
  @IsIn([...VALID_GENDERS], { message: 'Giới tính không hợp lệ' })
  gender?: string | null;

  @ApiPropertyOptional({
    example: '123 Example Street, District 1',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf(skipIfNull)
  @IsString()
  current_address?: string | null;

  @ApiPropertyOptional({ example: 'Công ty ABC', nullable: true })
  @IsOptional()
  @ValidateIf(skipIfNull)
  @IsString()
  company_name?: string | null;

  @ApiPropertyOptional({
    example: 'user@example.com',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf(skipIfNullOrEmpty)
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string | null;

  @ApiPropertyOptional({
    example: 10,
    description:
      'Gán contact cho user (null để bỏ gán). Cần quyền contacts.transfer phủ người nhận.',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'assigned_to phải là số nguyên' })
  assigned_to?: number | null;

  @ApiPropertyOptional({
    example: 2,
    description:
      'Chuyển contact sang team khác. Giới hạn theo phạm vi quyền của người thao tác.',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'team_id phải là số nguyên' })
  team_id?: number | null;

  @ApiPropertyOptional({
    type: [ContactCustomFieldDto],
    description:
      'Custom fields do owner hoặc super_admin tạo, tối đa 20 field/contact.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, {
    message: 'Tối đa 20 custom field trên 1 hồ sơ',
  })
  @ValidateNested({ each: true })
  @Type(() => ContactCustomFieldDto)
  custom_fields?: ContactCustomFieldDto[];
}
