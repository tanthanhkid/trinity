import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RejectRequestDto {
  @ApiPropertyOptional({ example: 'Không đủ bằng chứng xác thực', description: 'Ghi chú từ chối (tối đa 500 ký tự)' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'review_note tối đa 500 ký tự' })
  review_note?: string;
}
