import { IsString, IsOptional, MaxLength, MinLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiProperty({ example: 'Retail' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'retail' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9_]+$/, { message: 'Mã chỉ gồm chữ thường, số và dấu gạch dưới' })
  code: string;

  @ApiPropertyOptional({ example: 'blue' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;
}
