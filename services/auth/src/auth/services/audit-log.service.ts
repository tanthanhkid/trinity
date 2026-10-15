import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'

/**
 * Lý do THẬT của 1 lượt đăng nhập thất bại/thành công — để phân biệt
 * "email không tồn tại" vs "sai mật khẩu" vs "tài khoản bị khoá" khi điều tra
 * một ca "không login được". KHÔNG BAO GIỜ log mật khẩu/hash — chỉ log NGUYÊN NHÂN.
 */
export type LoginAttemptReason =
  | 'ok' // thành công
  | 'email_not_found' // không tìm thấy user khớp email (case-insensitive)
  | 'bad_password' // email khớp nhưng sai mật khẩu
  | 'account_locked' // user.status !== 'active'
  | 'rate_limited' // vượt quá số lần thử cho phép trong cửa sổ
  | 'wifi_blocked' // không khớp IP văn phòng active nào
  | 'owner_mismatch' // /public/auth/login — email khớp nhưng không phải owner của API key
  | 'role_not_allowed' // /public/auth/login — user không có quyền contacts.create (hoặc là Quản trị)

interface LoginAuditParams {
  userId: number | null
  email: string
  success: boolean
  ipAddress: string | null
  reason: LoginAttemptReason
}

/**
 * Cách thức ghi mật khẩu — dùng để phân biệt các đường ghi
 * `password_hash` khi điều tra "mật khẩu tự đổi". KHÔNG BAO GIỜ log giá trị
 * mật khẩu/hash — chỉ log SIÊU DỮ LIỆU (ai, khi nào, qua đường nào).
 */
export type PasswordChangeMethod =
  | 'self_change' // PATCH /auth/password — user tự đổi, yêu cầu mật khẩu hiện tại đúng
  | 'self_reset' // POST /auth/reset-password — user tự bấm reset cho chính mình
  | 'admin_reset' // PATCH /users/:id/reset-password — actor có users.manage reset cho người khác (assertCanManageUser)
  | 'user_create' // POST /users — tạo user mới, set mật khẩu lần đầu

interface PasswordChangeAuditParams {
  /** null khi không xác định được actor (không nên xảy ra ở đường JWT-guarded). */
  actorUserId: number | null
  /** Optional để không phá caller cũ. */
  actorRole?: string | null
  targetUserId: number
  method: PasswordChangeMethod
  ipAddress?: string | null
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name)

  constructor(private readonly prisma: PrismaService) {}

  async logLogin(params: LoginAuditParams): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        user_id: params.userId,
        action: 'login',
        resource: 'auth',
        ip_address: params.ipAddress,
        metadata: {
          // `email` LUÔN là chuỗi RAW người dùng gõ (KHÔNG trim/lowercase)
          // đây chính là tín hiệu chẩn đoán (điện thoại tự viết
          // hoa chữ cái đầu): so `email` giữa các dòng fail liên tiếp lộ ra
          // biến thể hoa/thường mà lookup case-insensitive không còn thấy.
          email: params.email,
          success: params.success,
          reason: params.reason,
        },
      },
    })
  }

  /**
   * Ghi vết mọi lần thay đổi mật khẩu — best-effort, KHÔNG throw.
   * Lỗi ghi audit KHÔNG được chặn thao tác đổi/reset mật khẩu chính.
   */
  async logPasswordChange(params: PasswordChangeAuditParams): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          user_id: params.actorUserId,
          action: 'password_change',
          resource: 'users',
          resource_id: params.targetUserId,
          ip_address: params.ipAddress ?? null,
          metadata: {
            method: params.method,
            actor_role: params.actorRole ?? null,
            target_user_id: params.targetUserId,
          },
        },
      })
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      this.logger.error(
        `Failed to write password-change audit log [method=${params.method} target=${params.targetUserId}]: ${msg}`,
      )
    }
  }
}
