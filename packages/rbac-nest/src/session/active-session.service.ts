import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { currentCompanyId, syncBus, tenantKey, tenantKeyFor } from '@trinity/prisma'

/**
 * Theo dõi phiên đăng nhập "đang sống" gần nhất của mỗi user —
 * ("mỗi tài khoản chỉ đăng nhập được 1 phiên; đăng nhập mới đá phiên cũ").
 *
 * ⚠️ Chỉ hoạt động khi `AuthService.isSingleSessionActive()` = true (kill-switch
 * mặc định TẮT ở CẢ env LẪN Settings DB).
 *
 * **Phạm vi CỐ Ý giới hạn — đọc kỹ trước khi mở rộng:**
 * - In-memory (Map), CÙNG mẫu với `TokenBlacklistService` (2 service này chuyển
 *   sang `@trinity/rbac-nest` — vì
 *   `JwtAuthGuard` dùng chung cho mọi service cần chúng).
 *   Restart service → map rỗng → MỌI token cũ đều fail-open (coi là phiên hợp lệ)
 *   cho tới khi user đó đăng nhập lại — tránh đăng xuất hàng loạt sau mỗi lần
 *   deploy (fail-open).
 * - CHỈ enforce tại `AuthService.refresh()` + JwtAuthGuard của CHÍNH Auth service
 *   (các endpoint `/auth/me`, `/auth/password`...). KHÔNG enforce ở CRM/
 *   Payroll/Notification — các service đó verify JWT CỤC BỘ bằng chữ ký,
 *   KHÔNG gọi lại Auth mỗi request. Muốn "đá" tức thời xuyên suốt toàn hệ thống
 *   sẽ phải thêm check này vào JwtAuthGuard của mọi service — rủi ro regression
 *   cao, CỐ Ý để ngoài phạm vi.
 * - Vì access token sống tối đa 15 phút, phiên cũ ở các service khác vẫn dùng được tới
 *   khi access token hết hạn rồi thử refresh — lúc đó mới bị từ chối.
 */
@Injectable()
export class ActiveSessionService implements OnModuleDestroy {
  private readonly sessions = new Map<string, string>() // keyed by tenantKey(userId)
  private readonly unsubscribe: Array<() => void> = []

  constructor() {
    // G12b: phiên mới/đăng xuất ở tiến trình khác (`NOTIFY session`).
    this.unsubscribe.push(
      syncBus.on('session', (m) => {
        const u = Number(m['u'])
        if (!Number.isInteger(u)) return
        const key = tenantKeyFor(m.c, u)
        if (m['op'] === 'clear') this.sessions.delete(key)
        else if (m['op'] === 'start' && typeof m['s'] === 'string') this.sessions.set(key, m['s'])
      }),
    )
  }

  onModuleDestroy(): void {
    for (const u of this.unsubscribe.splice(0)) u()
  }

  /** Đăng ký phiên MỚI cho user — trả về sessionId để nhúng vào JWT. Ghi đè phiên cũ (nếu có). */
  startSession(userId: number): string {
    const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    this.sessions.set(tenantKey(userId), sessionId)
    void syncBus.publish('session', { op: 'start', u: userId, s: sessionId }, currentCompanyId())
    return sessionId
  }

  /**
   * true khi `sessionId` khớp phiên đang lưu, HOẶC user chưa có phiên nào được
   * theo dõi (fail-open — vd vừa restart service, hoặc token mint từ TRƯỚC khi
   * bật tính năng nên chưa từng gọi `startSession`).
   */
  isCurrentSession(userId: number, sessionId: string | undefined): boolean {
    const current = this.sessions.get(tenantKey(userId))
    if (current === undefined) return true
    if (!sessionId) return true
    return current === sessionId
  }

  /** Gỡ theo dõi phiên của user (vd logout tường minh). Không bắt buộc gọi. */
  clearUser(userId: number): void {
    this.sessions.delete(tenantKey(userId))
    void syncBus.publish('session', { op: 'clear', u: userId }, currentCompanyId())
  }

  /** Exposed for testing */
  clear(): void {
    this.sessions.clear()
  }
}
