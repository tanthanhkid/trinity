import { IsString, IsNotEmpty, MaxLength, IsOptional, Allow } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DeviceCheckDto {
  @ApiProperty({
    description: 'UUID thiết bị từ localStorage',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  device_id!: string;

  @ApiPropertyOptional({ description: 'Ghi chú chấm công (tùy chọn)', example: 'Đi muộn vì kẹt xe' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * Trường file ảnh selfie (multipart). Được FileInterceptor('selfie') tách ra khỏi body,
   * nhưng phải @Allow() để global ValidationPipe (whitelist + forbidNonWhitelisted)
   * KHÔNG reject "property selfie should not exist".
   */
  @Allow()
  selfie?: unknown;
}
