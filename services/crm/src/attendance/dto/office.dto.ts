import { IsString, IsNotEmpty, IsOptional, IsArray, IsBoolean, MaxLength, ArrayNotEmpty, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateOfficeDto {
  @ApiProperty({ description: 'Tên văn phòng', example: 'Văn phòng Hà Nội' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Mô tả', example: 'VP chính tại Hà Nội' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: 'Danh sách IP văn phòng', example: ['203.0.113.108', '203.0.113.123'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ips!: string[];

  @ApiPropertyOptional({ description: 'Trạng thái hoạt động', default: true })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'Văn phòng demo (chỉ super_admin, bỏ qua kiểm tra IP)', default: false })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_demo?: boolean;
}

export class UpdateOfficeDto {
  @ApiPropertyOptional({ description: 'Tên văn phòng' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Mô tả' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Danh sách IP văn phòng' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ips?: string[];

  @ApiPropertyOptional({ description: 'Trạng thái hoạt động' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'Văn phòng demo (chỉ super_admin, bỏ qua kiểm tra IP)' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_demo?: boolean;
}
