import {
  IsOptional,
  IsDateString,
  IsArray,
  IsString,
  IsInt,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Query param có thể là 1 giá trị, mảng, hoặc chuỗi CSV → mảng chuỗi đã trim, bỏ rỗng. */
function toStringArray(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const out = arr.map((v) => String(v).trim()).filter((v) => v.length > 0);
  return out.length ? out : undefined;
}

/** Tương tự `toStringArray` nhưng ép sang số nguyên (bỏ giá trị không hợp lệ). */
function toIntArray(value: unknown): number[] | undefined {
  if (value == null) return undefined;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const out = arr
    .map((v) => parseInt(String(v).trim(), 10))
    .filter((n) => Number.isFinite(n));
  return out.length ? out : undefined;
}

/**
 * Filter cho thống kê chấm công tổng hợp + lọc theo Phòng ban / Team / Văn phòng
 * (thống kê theo nhóm). Mặc định khoảng = tháng hiện tại (giờ VN). Bộ lọc rỗng = xem tất cả.
 */
export class QueryAttendanceStatsDto {
  @ApiPropertyOptional({ description: 'Từ ngày (ISO date, VD: 2026-06-01)' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiPropertyOptional({ description: 'Đến ngày (ISO date, VD: 2026-06-30)' })
  @IsOptional()
  @IsDateString()
  date_to?: string;

  @ApiPropertyOptional({
    description: 'Lọc theo phòng ban (nhãn employees.department, "Chưa phân phòng" cho NV chưa gán)',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsArray()
  @IsString({ each: true })
  department?: string[];

  @ApiPropertyOptional({
    description: 'Lọc theo Team — danh sách users.id của quản lý trực tiếp',
    isArray: true,
    type: Number,
  })
  @IsOptional()
  @Transform(({ value }) => toIntArray(value))
  @IsArray()
  @IsInt({ each: true })
  team_id?: number[];

  @ApiPropertyOptional({
    description: 'Lọc theo Văn phòng — danh sách attendance_offices.id',
    isArray: true,
    type: Number,
  })
  @IsOptional()
  @Transform(({ value }) => toIntArray(value))
  @IsArray()
  @IsInt({ each: true })
  office_id?: number[];
}
