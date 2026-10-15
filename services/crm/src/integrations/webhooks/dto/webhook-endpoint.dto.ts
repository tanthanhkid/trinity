import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsString, IsUrl, Length, MaxLength, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { INTEGRATION_EVENT_TYPES } from '@trinity/prisma';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const EVENTS = [...INTEGRATION_EVENT_TYPES];

export class CreateWebhookEndpointDto {
  @ApiProperty({ example: 'Zapier — khách mới' })
  @Transform(trim)
  @IsString()
  @Length(1, 100, { message: 'Tên từ 1 đến 100 ký tự' })
  name!: string;

  @ApiProperty({ example: 'https://hooks.example.com/trinity' })
  @Transform(trim)
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true, require_tld: false }, { message: 'URL không hợp lệ' })
  url!: string;

  @ApiProperty({ enum: EVENTS, isArray: true })
  @IsArray()
  @ArrayMinSize(1, { message: 'Chọn ít nhất 1 sự kiện' })
  @ArrayMaxSize(EVENTS.length)
  @ArrayUnique()
  @IsIn(EVENTS, { each: true, message: 'Sự kiện không hợp lệ' })
  events!: string[];
}

export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true, require_tld: false }, { message: 'URL không hợp lệ' })
  url?: string;

  @ApiPropertyOptional({ enum: EVENTS, isArray: true })
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EVENTS.length)
  @ArrayUnique()
  @IsIn(EVENTS, { each: true })
  events?: string[];

  @ApiPropertyOptional()
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_active?: boolean;
}
