import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  Matches,
  IsDateString,
  IsIn,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateEmployeeDto {
  // === Thông tin tài khoản CRM (tạo user trong auth service) ===
  @ApiProperty({ description: 'Email đăng nhập', example: 'nguyen.van.a@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ description: 'Họ và tên đầy đủ', example: 'Nguyễn Văn A' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  full_name!: string;

  @ApiProperty({ description: 'Mật khẩu tạm thời (tối thiểu 8 ký tự)', minLength: 8 })
  @IsString()
  @IsOptional()
  @MinLength(8)
  password?: string;

  // Vai trò hệ thống KHÔNG gán ở đây — dùng `PUT /users/:id/roles` (quyền `users.manage`) sau khi tạo nhân viên.

  @ApiPropertyOptional({ description: 'Mã nhân viên (nhập tay; để trống sẽ tự sinh NVxxxx)', example: 'NV001' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  employee_code?: string;

  @ApiPropertyOptional({ description: 'SĐT', example: '0901234567' })
  @IsOptional()
  @IsString()
  @Matches(/^(0|\+84)\d{9}$/, { message: 'SĐT không hợp lệ' })
  phone?: string;

  @ApiPropertyOptional({ description: 'ID team (CRM)', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  team_id?: number;

  @ApiPropertyOptional({ description: 'ID quản lý trực tiếp (CRM user id)', example: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  manager_id?: number;

  @ApiPropertyOptional({
    description: 'Mức lương đóng BHXH (VNĐ) — nhập tay; null/để trống = dùng lương cơ bản',
    example: 4500000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  insurance_salary?: number | null;

  // === Thông tin nhân viên (bảng employees) ===
  @ApiProperty({ description: 'Chức vụ', example: 'sales' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string;

  @ApiPropertyOptional({ description: 'Phòng ban', example: 'KD' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @ApiPropertyOptional({
    description: 'Giới tính',
    enum: ['M', 'F'],
  })
  @IsOptional()
  @IsIn(['M', 'F'])
  gender?: string;

  @ApiPropertyOptional({
    description: 'Trạng thái làm việc',
    enum: ['unclassified', 'active', 'on_leave', 'probation', 'waiting', 'resigned'],
    default: 'active',
  })
  @IsOptional()
  @IsIn(['unclassified', 'active', 'on_leave', 'probation', 'waiting', 'resigned'])
  status?: string = 'active';

  @ApiPropertyOptional({
    description: 'Trình độ học vấn',
    enum: ['dai_hoc_tro_len', 'cao_dang', 'trung_cap', 'thpt_12', 'thcs', 'khac'],
  })
  @IsOptional()
  @IsIn(['dai_hoc_tro_len', 'cao_dang', 'trung_cap', 'thpt_12', 'thcs', 'khac'])
  education_level?: string;

  @ApiPropertyOptional({
    description: 'Kênh tuyển dụng',
    enum: ['hr', 'internal'],
  })
  @IsOptional()
  @IsIn(['hr', 'internal'])
  recruitment_source?: string;

  @ApiPropertyOptional({ description: 'Ngày vào làm (ISO date)', example: '2026-01-01' })
  @IsOptional()
  @IsDateString()
  joined_at?: string;

  @ApiPropertyOptional({ description: 'ID nhóm lương', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  salary_rule_id?: number;

  @ApiPropertyOptional({ description: 'ID chức danh (job_titles)', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  job_title_id?: number;

  @ApiPropertyOptional({ description: 'ID văn phòng chấm công', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  office_id?: number;

  @ApiPropertyOptional({ description: 'Base64 data-URL ảnh đại diện (BE chuyển thành file) hoặc đường dẫn /uploads/avatars/ đã lưu' })
  @IsOptional()
  @IsString()
  @MaxLength(5_500_000, { message: 'Ảnh đại diện quá lớn — tối đa 5MB' })
  avatar_url?: string | null;

  // === Hồ sơ nhân sự cá nhân ===
  @ApiPropertyOptional({ description: 'Ngày sinh (ISO date)', example: '1995-08-20' })
  @IsOptional()
  @ValidateIf((o: CreateEmployeeDto) => o.birth_date !== null && o.birth_date !== '')
  @IsDateString()
  birth_date?: string | null;

  @ApiPropertyOptional({ description: 'Số CCCD/CMND' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  id_card_number?: string | null;

  @ApiPropertyOptional({ description: 'Ngày cấp CCCD (ISO date)' })
  @IsOptional()
  @ValidateIf((o: CreateEmployeeDto) => o.id_card_issued_date !== null && o.id_card_issued_date !== '')
  @IsDateString()
  id_card_issued_date?: string | null;

  @ApiPropertyOptional({ description: 'Nơi cấp CCCD' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  id_card_issued_place?: string | null;

  @ApiPropertyOptional({ description: 'Hộ khẩu thường trú' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  permanent_address?: string | null;

  @ApiPropertyOptional({ description: 'Chỗ ở hiện tại' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  current_address?: string | null;

  @ApiPropertyOptional({ description: 'Số tài khoản ngân hàng' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  bank_account_number?: string | null;

  @ApiPropertyOptional({ description: 'Tên ngân hàng' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  bank_name?: string | null;

  @ApiPropertyOptional({ description: 'Tên chủ tài khoản' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  bank_account_holder?: string | null;
}
