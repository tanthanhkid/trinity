import { IsArray, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateWorkingSaturdaysDto {
  @ApiProperty({
    description: 'Danh sách thứ 7 được tính đi làm (YYYY-MM-DD)',
    example: ['2026-06-06', '2026-06-20'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    each: true,
    message: 'Mỗi ngày phải có dạng YYYY-MM-DD',
  })
  dates!: string[];
}
