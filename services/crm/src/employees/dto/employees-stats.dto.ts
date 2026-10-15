import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Bộ lọc phạm vi cho dashboard "Thống kê nhân viên" (Team + Sinh nhật).
 * - office_id / department / job_title_id: cột DB → lọc trực tiếp trong WHERE.
 * - team: team_lead user id (số) HOẶC 'none' (Chưa có team) → lọc app-layer
 *   vì Team được suy từ cây quản lý và bảng `teams`.
 */
export class HrStatsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  office_id?: number;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  team?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  job_title_id?: number;
}

/** Danh sách sinh nhật theo tháng — thêm `month` (1-12) cạnh 4 filter scope. */
export class BirthdayListQueryDto extends HrStatsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;
}
