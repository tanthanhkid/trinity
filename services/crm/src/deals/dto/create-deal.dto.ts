import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsIn,
  Min,
  MaxLength,
} from 'class-validator';

export class CreateDealDto {
  @ApiProperty({ example: 'Thương vụ gói dịch vụ 12 tháng', description: 'Tên thương vụ' })
  @IsNotEmpty({ message: 'Tên thương vụ không được để trống' })
  @IsString()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional({ example: 'Khách hàng cần báo giá gói dịch vụ', description: 'Mô tả' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: 500000000, description: 'Giá trị thương vụ (VND)' })
  @IsOptional()
  @IsInt({ message: 'Giá trị phải là số nguyên' })
  @Min(0)
  value?: number;

  @ApiPropertyOptional({ example: 'open', description: 'Trạng thái: open, won, lost' })
  @IsOptional()
  @IsIn(['open', 'won', 'lost'])
  status?: string;

  @ApiPropertyOptional({ example: 'Ghi chú thêm', description: 'Ghi chú' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiProperty({ example: 5, description: 'ID sale được gán thương vụ' })
  @IsNotEmpty({ message: 'Phải chọn sale phụ trách' })
  @IsInt({ message: 'assigned_to phải là số nguyên' })
  assigned_to!: number;

  @ApiPropertyOptional({ example: 123, description: 'ID contact liên kết (optional)' })
  @IsOptional()
  @IsInt()
  contact_id?: number;
}
