import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const PHONE = /^(0|\+84)\d{9}$/;

/** Khách gắn kèm (tuỳ chọn): tìm theo SĐT trong phạm vi người giữ khoá; không thấy mà có tên thì tạo mới. */
class PublicContactRef {
  @ApiPropertyOptional({ example: '0912345678', description: 'SĐT khách (0… hoặc +84…). Tìm khách có sẵn theo SĐT.' })
  @IsOptional()
  @Matches(PHONE, { message: 'contact_phone phải là SĐT Việt Nam 0xxxxxxxxx hoặc +84xxxxxxxxx' })
  contact_phone?: string;

  @ApiPropertyOptional({ example: 'Nguyễn Văn A', description: 'Tên khách — chỉ dùng khi chưa có khách với SĐT này (tạo mới).' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  contact_name?: string;

  @ApiPropertyOptional({ example: 3, description: 'Nguồn khách (GET /public/contacts/sources) cho khách tạo mới.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  contact_source_id?: number;
}

export class PublicCreateDealDto extends PublicContactRef {
  @ApiProperty({ example: 'Đơn #1024 từ website', description: 'Tên thương vụ / đơn' })
  @IsString()
  @Length(1, 255)
  title!: string;

  @ApiPropertyOptional({ example: 1500000, description: 'Giá trị (VND)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1e15)
  value?: number;

  @ApiPropertyOptional({ example: 'open', enum: ['open', 'won', 'lost'] })
  @IsOptional()
  @IsIn(['open', 'won', 'lost'])
  status?: 'open' | 'won' | 'lost';

  @ApiPropertyOptional({ description: 'Mô tả' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ description: 'Ghi chú' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  note?: string;
}

export class PublicCreateTaskDto extends PublicContactRef {
  @ApiProperty({ example: 12, description: 'Cột Kanban nhận việc (GET /public/tasks/columns)' })
  @Type(() => Number)
  @IsInt()
  column_id!: number;

  @ApiProperty({ example: 'Gọi lại khách hỏi giá', description: 'Tên việc' })
  @IsString()
  @Length(1, 500)
  title!: string;

  @ApiPropertyOptional({ description: 'Mô tả' })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @ApiPropertyOptional({ example: '2026-10-20T09:00:00+07:00', description: 'Hạn (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  due_at?: string;

  @ApiPropertyOptional({ enum: ['low', 'normal', 'high', 'urgent'] })
  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;

  @ApiPropertyOptional({ type: [String], example: ['zapier'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  labels?: string[];

  @ApiPropertyOptional({ example: { khu_vuc: 'HCM' }, description: 'Giá trị field tuỳ biến của bảng (khoá = `fields[].key` trong GET /public/tasks/columns). Bảng có field bắt buộc thì phải gửi.' })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}
