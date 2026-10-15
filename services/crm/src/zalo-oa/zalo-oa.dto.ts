import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class SendTextDto {
  @ApiProperty({ description: 'Nội dung tin tư vấn (1–2000 ký tự)' })
  @IsString()
  @Length(1, 2000)
  text!: string;
}

export class SendZnsDto {
  @ApiProperty({ example: '0912345678' })
  @IsString()
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ description: 'Id mẫu ZNS đã được Zalo duyệt' })
  @IsString()
  @Matches(/^\d{1,20}$/, { message: 'template_id chỉ gồm chữ số' })
  template_id!: string;

  @ApiProperty({ description: 'Giá trị điền vào tham số của mẫu (chuỗi)', example: { customer_name: 'Lan' } })
  @IsObject()
  template_data!: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(48)
  tracking_id?: string;
}

export class LinkThreadDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  contact_id?: number;

  @ApiPropertyOptional({ description: 'Tìm khách theo SĐT, chưa có thì tạo mới' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
