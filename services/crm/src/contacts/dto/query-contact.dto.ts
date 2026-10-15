import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  IsIn,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * filter keys mới — bỏ `status`/`sub_status`/`tag_id`, thêm
 * `stage_id` + `contact_status_id` + `source_id`.
 */
export class QueryContactDto {
  @ApiPropertyOptional({ description: 'Cursor ID cho phân trang (legacy, dùng cho infinite scroll cũ)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cursor?: number;

  @ApiPropertyOptional({
    description:
      'Số trang (page-number pagination). Khi truyền `page` → service trả thêm `meta.total` + `meta.pages`. ' +
      'Giới hạn `page * limit ≤ giới hạn skip tối đa của service` để tránh OFFSET trên bảng lớn.',
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Số bản ghi tối đa (1-200, mặc định 50)',
    default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Filter theo giai đoạn (SettingOption group_key=contact_stage)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  stage_id?: number;

  @ApiPropertyOptional({
    description:
      'Filter theo trạng thái chi tiết (SettingOption group_key=contact_detail_status)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  contact_status_id?: number;

  @ApiPropertyOptional({
    description: 'Filter theo nguồn (SettingOption group_key=contact_source)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  source_id?: number;

  @ApiPropertyOptional({ description: 'Filter theo team ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  team_id?: number;

  @ApiPropertyOptional({ description: 'Filter theo người được gán' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  assigned_to?: number;

  @ApiPropertyOptional({
    description: 'Filter theo dự án (Contact.project_id). Index đã có trên contacts.project_id.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  project_id?: number;

  @ApiPropertyOptional({
    description: 'Filter theo team_lead user ID — resolve sang assigned_to IN [tl_id, ...subordinates].',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  team_lead_id?: number;

  @ApiPropertyOptional({
    description: 'Filter theo user ID cấp quản lý — resolve sang assigned_to IN [manager, ...2 cấp cấp dưới].',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  dept_head_id?: number;

  @ApiPropertyOptional({
    description: 'Filter theo người tạo (Contact.created_by_id).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  creator_id?: number;

  @ApiPropertyOptional({
    description: 'Tìm kiếm theo SĐT hoặc tên',
    example: '094601',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Lọc từ ngày tạo (YYYY-MM-DD hoặc ISO-8601)',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString({}, { message: 'created_from phải là ngày hợp lệ (YYYY-MM-DD)' })
  created_from?: string;

  @ApiPropertyOptional({
    description: 'Lọc đến ngày tạo (YYYY-MM-DD hoặc ISO-8601)',
    example: '2026-12-31',
  })
  @IsOptional()
  @IsDateString({}, { message: 'created_to phải là ngày hợp lệ (YYYY-MM-DD)' })
  created_to?: string;

  @ApiPropertyOptional({
    description: 'Sắp xếp theo: created_at, full_name, id, lead_score (điểm lead, NULL xuống cuối)',
    example: 'created_at',
  })
  @IsOptional()
  @IsString()
  @IsIn(['created_at', 'full_name', 'id', 'lead_score'], {
    message: 'sort_by không hợp lệ',
  })
  sort_by?: string;

  @ApiPropertyOptional({
    description: 'Thứ tự sắp xếp: asc hoặc desc',
    example: 'desc',
  })
  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'], { message: 'sort_order phải là asc hoặc desc' })
  sort_order?: string;

  @ApiPropertyOptional({
    description: 'Lọc theo nhãn điểm lead: hot=Nóng, warm=Ấm, cold=Lạnh, unscored=chưa chấm',
    enum: ['hot', 'warm', 'cold', 'unscored'],
  })
  @IsOptional()
  @IsIn(['hot', 'warm', 'cold', 'unscored'], { message: 'lead_label không hợp lệ' })
  lead_label?: 'hot' | 'warm' | 'cold' | 'unscored';
}
