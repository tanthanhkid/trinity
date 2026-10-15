import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const ATTENDANCE_REQUEST_TYPES = [
  'forgot_check_in',
  'forgot_check_out',
  'late_arrival',
  'early_leave',
  'leave',
  'maternity',
] as const;

export type AttendanceRequestType = (typeof ATTENDANCE_REQUEST_TYPES)[number];

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateAttendanceRequestDto {
  @ApiProperty({ example: '2026-06-17', description: 'Ngày cần điều chỉnh (YYYY-MM-DD)' })
  @Matches(DATE_RE, { message: 'work_date phải có định dạng YYYY-MM-DD' })
  work_date!: string;

  @ApiProperty({ enum: ATTENDANCE_REQUEST_TYPES, description: 'Loại đơn chấm công' })
  @IsIn(ATTENDANCE_REQUEST_TYPES, { message: 'Loại đơn không hợp lệ' })
  type!: AttendanceRequestType;

  @ApiPropertyOptional({ example: '08:15', description: 'Giờ check-in đề nghị (HH:MM VN) — bắt buộc khi type=forgot_check_in' })
  @IsOptional()
  @Matches(HM_RE, { message: 'requested_check_in phải có định dạng HH:MM (vd 08:05)' })
  requested_check_in?: string;

  @ApiPropertyOptional({ example: '17:30', description: 'Giờ check-out đề nghị (HH:MM VN) — bắt buộc khi type=forgot_check_out' })
  @IsOptional()
  @Matches(HM_RE, { message: 'requested_check_out phải có định dạng HH:MM (vd 17:30)' })
  requested_check_out?: string;

  @ApiProperty({ example: 'Quên quẹt thẻ do đến muộn 5 phút', description: 'Lý do (tối đa 500 ký tự)' })
  @IsString()
  @MinLength(1, { message: 'Lý do không được để trống' })
  @MaxLength(500, { message: 'Lý do tối đa 500 ký tự' })
  reason!: string;
}
