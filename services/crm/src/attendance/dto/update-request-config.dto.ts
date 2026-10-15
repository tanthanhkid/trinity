import { IsInt, IsString, Matches, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateRequestConfigDto {
  @ApiProperty({ example: '08:00', description: 'Giờ check-in mặc định khi duyệt đơn quên check-in (HH:MM VN)' })
  @IsString()
  @Matches(HM_RE, { message: 'default_check_in phải có định dạng HH:MM (vd 08:00)' })
  default_check_in!: string;

  @ApiProperty({ example: '17:30', description: 'Giờ check-out mặc định khi duyệt đơn quên check-out (HH:MM VN)' })
  @IsString()
  @Matches(HM_RE, { message: 'default_check_out phải có định dạng HH:MM (vd 17:30)' })
  default_check_out!: string;

  @ApiProperty({ example: 2, description: 'Số đơn quên check-in/check-out tối đa mỗi tháng (0 = không giới hạn)' })
  @Type(() => Number)
  @IsInt({ message: 'monthly_forgot_limit phải là số nguyên' })
  @Min(0, { message: 'monthly_forgot_limit không được âm' })
  monthly_forgot_limit!: number;

  @ApiProperty({ example: 3, description: 'Số đơn đi muộn/về sớm tối đa mỗi tháng (0 = không giới hạn)' })
  @Type(() => Number)
  @IsInt({ message: 'monthly_late_early_limit phải là số nguyên' })
  @Min(0, { message: 'monthly_late_early_limit không được âm' })
  monthly_late_early_limit!: number;
}
