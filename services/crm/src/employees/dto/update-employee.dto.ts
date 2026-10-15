import {
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  Matches,
  IsDateString,
  IsIn,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class UpdateEmployeeDto {
  // === Cập nhật thông tin User ===
  @ApiPropertyOptional({ description: 'Họ và tên' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  full_name?: string;

  @ApiPropertyOptional({ description: 'SĐT' })
  @IsOptional()
  @IsString()
  @Matches(/^(0|\+84)\d{9}$/, { message: 'SĐT không hợp lệ' })
  phone?: string;

  // Vai trò hệ thống KHÔNG gán ở đây — dùng `PUT /users/:id/roles` (quyền `users.manage`).

  @ApiPropertyOptional({ description: 'Mã nhân viên (nhập tay)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  employee_code?: string;

  @ApiPropertyOptional({ description: 'ID team (CRM)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  team_id?: number;

  @ApiPropertyOptional({
    description:
      'ID quản lý trực tiếp (Bộ phận = người quản lý phụ trách); null để bỏ gán',
    nullable: true,
  })
  @IsOptional()
  // Cho phép null (bỏ gán Bộ phận) — null bỏ qua @IsInt; số nguyên vẫn validate.
  @ValidateIf((o: UpdateEmployeeDto) => o.manager_id !== null)
  @Type(() => Number)
  @IsInt()
  manager_id?: number | null;

  @ApiPropertyOptional({
    description: 'Mức lương đóng BHXH (VNĐ) — nhập tay; null/để trống = dùng lương cơ bản',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: UpdateEmployeeDto) => o.insurance_salary !== null)
  @Type(() => Number)
  @IsInt()
  insurance_salary?: number | null;

  // === Cập nhật thông tin nhân viên ===
  @ApiPropertyOptional({ description: 'Chức vụ' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string;

  @ApiPropertyOptional({ description: 'Phòng ban' })
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
  })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['unclassified', 'active', 'on_leave', 'probation', 'waiting', 'resigned'])
  status?: string;

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

  @ApiPropertyOptional({ description: 'Ngày vào làm (ISO date)' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsDateString()
  joined_at?: string;

  @ApiPropertyOptional({ description: 'ID nhóm lương' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  salary_rule_id?: number;

  @ApiPropertyOptional({ description: 'ID chức danh (job_titles)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  job_title_id?: number;

  @ApiPropertyOptional({ description: 'ID văn phòng chấm công' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  office_id?: number;

  @ApiPropertyOptional({ description: 'Base64 data-URL ảnh đại diện (BE chuyển thành file) hoặc đường dẫn /uploads/avatars/ đã lưu' })
  @IsOptional()
  @IsString()
  @MaxLength(5_500_000, { message: 'Ảnh đại diện quá lớn — tối đa 5MB' })
  avatar_url?: string | null;

  // === Hồ sơ nhân sự cá nhân; gửi "" để xoá ===
  @ApiPropertyOptional({ description: 'Ngày sinh (ISO date)' })
  @IsOptional()
  @ValidateIf((o: UpdateEmployeeDto) => o.birth_date !== null && o.birth_date !== '')
  @IsDateString()
  birth_date?: string | null;

  @ApiPropertyOptional({ description: 'Số CCCD/CMND' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  id_card_number?: string | null;

  @ApiPropertyOptional({ description: 'Ngày cấp CCCD (ISO date)' })
  @IsOptional()
  @ValidateIf((o: UpdateEmployeeDto) => o.id_card_issued_date !== null && o.id_card_issued_date !== '')
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
