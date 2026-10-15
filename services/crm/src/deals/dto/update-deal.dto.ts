import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsInt,
  IsIn,
  Min,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateDealDto {
  @ApiPropertyOptional({ example: 'Thương vụ cập nhật' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ example: 'Mô tả mới' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: 800000000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number;

  @ApiPropertyOptional({ example: 'won', description: 'open, won, lost' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['open', 'won', 'lost'])
  status?: string;

  @ApiPropertyOptional({ example: 'Ghi chú' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
