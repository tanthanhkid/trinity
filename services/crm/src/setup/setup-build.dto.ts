import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, ArrayMaxSize } from 'class-validator';
import { INDUSTRY_KEYS } from '@trinity/rbac';

export class BuildSystemDto {
  @ApiProperty({ enum: INDUSTRY_KEYS, description: 'Loại doanh nghiệp (4 mẫu có sẵn hoặc other = CRM cơ bản)' })
  @IsIn(INDUSTRY_KEYS as unknown as string[])
  industry!: string;

  @ApiPropertyOptional({ type: [String], description: 'Khoá phân hệ muốn dùng (bộ cơ bản luôn bật). Vắng = bộ gợi ý của ngành.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  features?: string[];
}
