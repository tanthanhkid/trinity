import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import {
  VALID_NOTIFICATION_SOUND_IDS,
  DEFAULT_NOTIFICATION_SOUND_ID,
  type NotificationSoundId,
} from './dto/notification-sound.dto';
import {
  DEFAULT_DEPARTMENTS,
  MAX_DEPARTMENTS,
  MAX_DEPARTMENT_NAME_LENGTH,
} from './dto/departments.dto';

const VALID_SOUND_IDS_SET = new Set<string>(VALID_NOTIFICATION_SOUND_IDS);

/**
 * Key-value store cho cac cai dat he thong.
 *
 * Menu ẩn/hiện suy trực tiếp từ quyền của FE (đọc `permissions` từ `/auth/me`),
 * không có cấu hình per-role riêng ở BE.
 */
const KEYS = {
  notificationSound: 'notification_sound_id',
  departmentList: 'department_list',
} as const;

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Âm báo thông báo CHUNG toàn hệ thống — áp dụng cho mọi
   * nhân viên. Đọc được cho mọi user đã đăng nhập; ghi cần quyền
   * `settings.integrations` (gate ở controller). Fallback mặc định khi chưa cấu hình / value rác.
   */
  async getNotificationSound(): Promise<{ sound_id: NotificationSoundId }> {
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: KEYS.notificationSound },
        select: { value: true },
      });
      const stored = row?.value;
      const sound_id =
        stored && VALID_SOUND_IDS_SET.has(stored)
          ? (stored as NotificationSoundId)
          : DEFAULT_NOTIFICATION_SOUND_ID;
      return { sound_id };
    } catch (err) {
      this.logger.error(
        `getNotificationSound failed: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
      // Không chặn UI vì lỗi đọc cấu hình — trả mặc định.
      return { sound_id: DEFAULT_NOTIFICATION_SOUND_ID };
    }
  }

  async updateNotificationSound(
    soundId: string,
    userId: number,
  ): Promise<{ sound_id: NotificationSoundId }> {
    if (!VALID_SOUND_IDS_SET.has(soundId)) {
      throw new BadRequestException(
        `sound_id không hợp lệ. Cho phép: ${VALID_NOTIFICATION_SOUND_IDS.join(', ')}`,
      );
    }
    try {
      await this.prisma.setting.upsert({
        where: { key: KEYS.notificationSound },
        update: { value: soundId, updated_by: userId },
        create: { key: KEYS.notificationSound, value: soundId, updated_by: userId },
      });
    } catch (err) {
      this.logger.error(
        `updateNotificationSound failed (user=${userId}): ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
      throw new InternalServerErrorException('Không cập nhật được âm báo thông báo');
    }
    this.logger.log(`Notification sound updated by user ${userId}: ${soundId}`);
    return { sound_id: soundId as NotificationSoundId };
  }

  /**
   * Danh sách PHÒNG BAN cấu hình chung — lưu Setting KV `department_list` dạng
   * JSON string. Mọi user đã đăng nhập đọc (dropdown form NV/HĐ/tuyển dụng/lọc); ghi cần
   * quyền `org.manage` (gate controller). Fallback DEFAULT_DEPARTMENTS khi chưa cấu hình/rác.
   */
  async getDepartments(): Promise<{ departments: string[] }> {
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: KEYS.departmentList },
        select: { value: true },
      });
      const parsed = this.parseDepartments(row?.value);
      return { departments: parsed ?? DEFAULT_DEPARTMENTS };
    } catch (err) {
      this.logger.error(
        `getDepartments failed: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
      return { departments: DEFAULT_DEPARTMENTS };
    }
  }

  async updateDepartments(
    departments: string[],
    userId: number,
  ): Promise<{ departments: string[] }> {
    const cleaned = this.sanitizeDepartments(departments);
    if (cleaned.length === 0) {
      throw new BadRequestException('Danh sách phòng ban không được rỗng');
    }
    try {
      await this.prisma.setting.upsert({
        where: { key: KEYS.departmentList },
        update: { value: JSON.stringify(cleaned), updated_by: userId },
        create: {
          key: KEYS.departmentList,
          value: JSON.stringify(cleaned),
          updated_by: userId,
        },
      });
    } catch (err) {
      this.logger.error(
        `updateDepartments failed (user=${userId}): ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
      throw new InternalServerErrorException(
        'Không cập nhật được danh sách phòng ban',
      );
    }
    this.logger.log(`Departments updated by user ${userId}: ${cleaned.length} mục`);
    return { departments: cleaned };
  }

  /** Parse + validate JSON string → string[] hợp lệ; null nếu rác/rỗng. */
  private parseDepartments(raw: string | null | undefined): string[] | null {
    if (!raw) return null;
    try {
      const arr: unknown = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      const cleaned = this.sanitizeDepartments(arr);
      return cleaned.length > 0 ? cleaned : null;
    } catch {
      return null;
    }
  }

  /** Trim, bỏ rỗng, cắt độ dài, dedupe (case-insensitive giữ bản đầu), cắt MAX. */
  private sanitizeDepartments(input: unknown[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of input) {
      if (typeof item !== 'string') continue;
      const name = item.trim().slice(0, MAX_DEPARTMENT_NAME_LENGTH);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= MAX_DEPARTMENTS) break;
    }
    return out;
  }

}
