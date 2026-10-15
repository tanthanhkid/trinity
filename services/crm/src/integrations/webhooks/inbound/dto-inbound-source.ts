import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Min, ValidateIf } from 'class-validator';
import { Transform, Type } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateInboundSourceDto {
  @ApiProperty({ example: 'Landing page Facebook' })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name!: string;

  @ApiProperty({ description: 'Sale nhận khách (owner của khách tạo ra); phải đang hoạt động' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  default_assignee_id!: number;

  @ApiProperty({ description: 'ID SettingOption group contact_source gán cho khách tạo ra' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  contact_source_id!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  project_id?: number;

  @ApiPropertyOptional({ description: 'true ⇒ sinh signing secret, bên gửi PHẢI ký X-Trinity-Signature' })
  @IsOptional()
  @IsBoolean()
  signed?: boolean;
}

export class UpdateInboundSourceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  default_assignee_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  contact_source_id?: number;

  @ApiPropertyOptional({ nullable: true, description: 'null ⇒ bỏ dự án' })
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  project_id?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'true ⇒ (tạo lại) signing secret, trả 1 lần; false ⇒ bỏ yêu cầu chữ ký' })
  @IsOptional()
  @IsBoolean()
  signed?: boolean;
}
