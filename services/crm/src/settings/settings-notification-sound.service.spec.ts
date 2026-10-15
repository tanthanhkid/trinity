import { BadRequestException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { DEFAULT_NOTIFICATION_SOUND_ID } from './dto/notification-sound.dto';

/**
 * Test âm báo thông báo CHUNG toàn hệ thống.
 * get: fallback mặc định khi chưa cấu hình / value rác; trả value hợp lệ khi có.
 * update: chặn id không hợp lệ (BadRequest); upsert + trả lại id khi hợp lệ.
 */
describe('SettingsService — notification sound (global)', () => {
  function makeService(settingMock: {
    findUnique?: jest.Mock;
    upsert?: jest.Mock;
  }) {
    const prisma = { setting: settingMock } as never;
    return new SettingsService(prisma);
  }

  describe('getNotificationSound', () => {
    it('trả mặc định "beep" khi chưa cấu hình', async () => {
      const svc = makeService({ findUnique: jest.fn().mockResolvedValue(null) });
      const res = await svc.getNotificationSound();
      expect(res.sound_id).toBe(DEFAULT_NOTIFICATION_SOUND_ID);
    });

    it('trả value hợp lệ đã lưu', async () => {
      const svc = makeService({
        findUnique: jest.fn().mockResolvedValue({ value: 'chime' }),
      });
      const res = await svc.getNotificationSound();
      expect(res.sound_id).toBe('chime');
    });

    it('fallback mặc định khi value rác trong DB', async () => {
      const svc = makeService({
        findUnique: jest.fn().mockResolvedValue({ value: 'rac-rac' }),
      });
      const res = await svc.getNotificationSound();
      expect(res.sound_id).toBe(DEFAULT_NOTIFICATION_SOUND_ID);
    });

    it('fallback mặc định khi đọc DB lỗi (không throw)', async () => {
      const svc = makeService({
        findUnique: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const res = await svc.getNotificationSound();
      expect(res.sound_id).toBe(DEFAULT_NOTIFICATION_SOUND_ID);
    });
  });

  describe('updateNotificationSound', () => {
    it('chặn id không hợp lệ', async () => {
      const upsert = jest.fn();
      const svc = makeService({ upsert });
      await expect(svc.updateNotificationSound('khong-ton-tai', 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(upsert).not.toHaveBeenCalled();
    });

    it('upsert + trả lại id khi hợp lệ', async () => {
      const upsert = jest.fn().mockResolvedValue({});
      const svc = makeService({ upsert });
      const res = await svc.updateNotificationSound('bell', 7);
      expect(res.sound_id).toBe('bell');
      expect(upsert).toHaveBeenCalledTimes(1);
      const arg = upsert.mock.calls[0][0];
      expect(arg.where.key).toBe('notification_sound_id');
      expect(arg.create.value).toBe('bell');
      expect(arg.update.value).toBe('bell');
      expect(arg.update.updated_by).toBe(7);
    });
  });
});
