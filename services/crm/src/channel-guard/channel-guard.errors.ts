import { HttpException, HttpStatus } from '@nestjs/common';

export type ChannelBlockCode = 'channel_locked' | 'channel_paused' | 'channel_quota';

/** Gửi ra ngoài bị chặn (khoá kênh, tạm dừng tự động, hết hạn mức). Lời báo tiếng Việt cho người dùng thường. */
export class ChannelBlockedError extends HttpException {
  /** Sự kiện chờ ghi (hết hạn mức xảy ra trong transaction: ghi sau transaction bằng `ChannelGuardService.recordBlocked`). */
  pendingEvent?: { kind: string; message: string; meta: Record<string, unknown>; dedupe: string; log: string };

  constructor(
    readonly blockCode: ChannelBlockCode,
    message: string,
  ) {
    super({ statusCode: blockCode === 'channel_locked' ? HttpStatus.FORBIDDEN : HttpStatus.TOO_MANY_REQUESTS, message, code: blockCode }, blockCode === 'channel_locked' ? HttpStatus.FORBIDDEN : HttpStatus.TOO_MANY_REQUESTS);
  }
}
