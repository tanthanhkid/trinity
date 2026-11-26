import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { currentCompanyId, syncBus, tenantKey, tenantKeyFor } from '@trinity/prisma'
import { runForEachCompany } from '../for-each-company'
import { deleteSession, loadSessions, saveSession } from './security-state'

/**
 * Theo dõi phiên đăng nhập "đang sống" gần nhất của mỗi user —
 * ("mỗi tài khoản chỉ đăng nhập được 1 phiên; đăng nhập mới đá phiên cũ").
 *
 * ⚠️ Chỉ hoạt động khi `AuthService.isSingleSessionActive()` = true (kill-switch
 * mặc định TẮT ở CẢ env LẪN Settings DB).
 *
 * **Phạm vi CỐ Ý giới hạn — đọc kỹ trước khi mở rộng:**
 * - RAM (Map) là lớp nhanh, CÙNG mẫu với `TokenBlacklistService` (2 service này ở
 *   `@trinity/rbac-nest` vì `JwtAuthGuard` dùng chung). G12b: phiên lưu bền ở bảng
 *   `active_sessions` và đồng bộ giữa tiến trình qua NOTIFY (kèm giờ thay đổi để tin cũ
 *   không ghi đè); khởi động lại / nối lại NOTIFY thì nạp lại từ bảng. User chưa có dòng
 *   nào vẫn fail-open (coi là phiên hợp lệ).
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
export class ActiveSessionService implements OnModuleInit, OnModuleDestroy {
  /** keyed by tenantKey(userId); `sid: null` = đã gỡ (dấu mộ để tin `start` cũ đến muộn không làm sống lại). `at`: giờ người phát. */
  private readonly sessions = new Map<string, { sid: string | null; at: number }>()
  private readonly unsubscribe: Array<() => void> = []

  constructor() {
    // G12b: phiên mới/đăng xuất ở tiến trình khác (`NOTIFY session`); chỉ áp khi không cũ hơn thay đổi đã có.
    this.unsubscribe.push(
      syncBus.on('session', (m) => {
        const u = Number(m['u'])
        const t = Number(m['t'])
        if (!Number.isInteger(u) || !Number.isFinite(t)) return
        if (m['op'] === 'clear') this.apply(tenantKeyFor(m.c, u), null, t)
        else if (m['op'] === 'start' && typeof m['s'] === 'string') this.apply(tenantKeyFor(m.c, u), m['s'], t)
      }),
      syncBus.onResync(() => void this.reload()),
    )
  }

  onModuleInit(): void {
    void this.reload()
  }

  onModuleDestroy(): void {
    for (const u of this.unsubscribe.splice(0)) u()
  }

  private apply(key: string, sid: string | null, at: number): void {
    const cur = this.sessions.get(key)
    if (cur && cur.at > at) return
    this.sessions.set(key, { sid, at })
  }

  /** Nạp lại từ bảng `active_sessions` (khởi động lại, hoặc nối lại NOTIFY sau lúc đứt): dòng mới hơn thắng. */
  async reload(): Promise<void> {
    try {
      await runForEachCompany(async () => {
        const cid = currentCompanyId() ?? 1
        const belongs = (key: string): boolean => (cid === 1 ? /^\d+$/.test(key) : key.startsWith(`c${cid}:`))
        const rows = await loadSessions()
        const seen = new Set<string>()
        for (const r of rows) {
          const key = tenantKey(r.user_id)
          seen.add(key)
          this.apply(key, r.session_id, r.started_at.getTime())
        }
        for (const [key, e] of this.sessions) {
          if (belongs(key) && e.sid !== null && !seen.has(key) && Date.now() - e.at > 5_000) this.sessions.set(key, { sid: null, at: Date.now() })
        }
      }, { key: 'active-session-reload' })
    } catch (e) {
      console.warn(`[active-session] nạp lại lỗi: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Đăng ký phiên MỚI cho user — trả về sessionId để nhúng vào JWT. Ghi đè phiên cũ (nếu có). */
  startSession(userId: number): string {
    const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const at = Date.now()
    this.sessions.set(tenantKey(userId), { sid: sessionId, at })
    void saveSession(userId, sessionId)
    void syncBus.publish('session', { op: 'start', u: userId, s: sessionId, t: at }, currentCompanyId())
    return sessionId
  }

  /**
   * true khi `sessionId` khớp phiên đang lưu, HOẶC user chưa có phiên nào được
   * theo dõi (fail-open — vd token mint từ TRƯỚC khi bật tính năng nên chưa từng
   * gọi `startSession`). Phiên lưu bền ở DB nên khởi động lại không còn làm mất theo dõi.
   */
  isCurrentSession(userId: number, sessionId: string | undefined): boolean {
    const current = this.sessions.get(tenantKey(userId))?.sid ?? undefined
    if (current === undefined) return true
    if (!sessionId) return true
    return current === sessionId
  }

  /** Gỡ theo dõi phiên của user (vd logout tường minh). Không bắt buộc gọi. */
  clearUser(userId: number): void {
    const at = Date.now()
    this.sessions.set(tenantKey(userId), { sid: null, at })
    void deleteSession(userId)
    void syncBus.publish('session', { op: 'clear', u: userId, t: at }, currentCompanyId())
  }

  /** Exposed for testing */
  clear(): void {
    this.sessions.clear()
  }
}
