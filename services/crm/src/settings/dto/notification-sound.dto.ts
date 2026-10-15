import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

/**
 * Danh sách id âm báo hợp lệ — PHẢI khớp `NOTIFICATION_SOUNDS` trong FE
 * `apps/web/src/lib/notification-sounds.ts`. Khi FE thêm âm mới → thêm id vào đây.
 */
export const VALID_NOTIFICATION_SOUND_IDS = [
  'beep',
  'ding-dong',
  'chime',
  'tri-tone',
  'pop',
  'sweep',
  'bell',
  'harp',
  'water-drop',
  'soft-bell',
  'upbeat',
  'power-up',
] as const;

export type NotificationSoundId = (typeof VALID_NOTIFICATION_SOUND_IDS)[number];

export const DEFAULT_NOTIFICATION_SOUND_ID: NotificationSoundId = 'beep';

export class UpdateNotificationSoundDto {
  @ApiProperty({
    example: 'beep',
    enum: VALID_NOTIFICATION_SOUND_IDS,
    description: 'Id âm báo áp dụng cho TOÀN HỆ THỐNG (mọi nhân viên).',
  })
  @IsString()
  @IsIn(VALID_NOTIFICATION_SOUND_IDS as unknown as string[])
  sound_id!: NotificationSoundId;
}
