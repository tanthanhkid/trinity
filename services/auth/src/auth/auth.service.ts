import {
  Injectable,
  Logger,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import sharp from 'sharp'
import { createUploadsStore, uploadsRelPathFromUrl } from '@trinity/storage'
import { PrismaService } from '@trinity/prisma'
import { PermissionService } from '@trinity/rbac-nest'
import { can, type Grants } from '@trinity/rbac'
import { LoginDto } from './dto/login.dto'
import { UpdateProfileDto } from './dto/update-profile.dto'
import { RateLimiterService } from './services/rate-limiter.service'
import { TokenBlacklistService } from '@trinity/rbac-nest'
import { AuditLogService, LoginAttemptReason } from './services/audit-log.service'
import { ActiveSessionService } from '@trinity/rbac-nest'
import { isLoginWifiCheckBypassed, isLoginWifiCheckEnabled, isUnusableLoginIp, loginIpMatchesOffice } from './login-wifi-check.helper'
import { resolveLoginWifiTargetedForUser } from './login-wifi-check-targets.helper'
import { isSingleSessionEnabled } from './single-session.helper'

// KV key trong bảng `settings` (Setting model dùng chung toàn hệ thống qua @trinity/prisma)
// công tắc Settings do người có quyền settings.integrations bật/tắt (
// (không thay thế) kill-switch env `LOGIN_WIFI_CHECK_ENABLED`.
const LOGIN_WIFI_CHECK_ENABLED_KEY = 'login_wifi_check_enabled'

// KV key mirror trên — công tắc "1 tài khoản chỉ 1 phiên đăng nhập".
const SINGLE_SESSION_ENABLED_KEY = 'single_session_enabled'

// 🔴 Payload JWT CHỈ còn danh tính, KHÔNG
// còn `role`/`team_id`. Quyền được tra riêng, theo yêu cầu, qua
// `PermissionService.grantsFor` (packages/rbac-nest) — không nằm trong token,
// nên admin sửa quyền có hiệu lực NGAY, không cần đăng nhập lại.
interface JwtPayload {
  sub: number
  email: string
  // CHỈ có khi tính năng 1-phiên/tài khoản đang bật lúc login.
  sid?: string
}

interface RefreshPayload {
  sub: number
  type: 'refresh'
  sid?: string
  /** Id PHIÊN đăng nhập: sinh lúc login, giữ nguyên qua mọi lần refresh; đăng xuất thu hồi theo id này. */
  jti?: string
  iat?: number
  exp?: number
}

interface UserWithRole {
  id: number
  email: string
  password_hash: string
  full_name: string
  avatar_url: string | null
  manager_id: number | null
  team_id: number | null
  status: string
  tokens_valid_after?: Date | null
  team: { name: string } | null
  user_roles: Array<{ role: { id: number; name: string; is_system: boolean } }>
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly rateLimiter: RateLimiterService,
    private readonly tokenBlacklist: TokenBlacklistService,
    private readonly auditLog: AuditLogService,
    private readonly activeSession: ActiveSessionService,
    private readonly permissionService: PermissionService,
  ) {}

  /** Hình dạng chung của `/auth/me` VÀ response login/refresh
   * FE có `permissions` ngay từ lúc đăng nhập, không cần gọi thêm request. */
  private toMeResponse(user: UserWithRole, grants: Grants, isAdmin: boolean) {
    return {
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        manager_id: user.manager_id,
      },
      roles: user.user_roles.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
        is_system: ur.role.is_system,
      })),
      permissions: grants,
      isAdmin,
    }
  }

  /** `GET /auth/me` — trả vai trò và quyền của người dùng. */
  async getMe(userId: number) {
    const user = await this.findUserById(userId)
    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }
    const { grants, isAdmin } = await this.permissionService.grantsFor(userId)
    return this.toMeResponse(user, grants, isAdmin)
  }

  async login(dto: LoginDto, ipAddress: string | null = null) {
    // key rate-limit chuẩn hoá (trim + lowercase) CHỈ để gộp
    // đúng 1 quota cho mọi biến thể hoa/thường của CÙNG email (điện thoại tự
    // viết hoa chữ cái đầu). Giá trị RAW `dto.email` (audit log, lookup) GIỮ
    // NGUYÊN — không đụng, vì đó là tín hiệu chẩn đoán chính.
    const rateLimitKey = `login:${ipAddress ?? 'unknown'}:${this.normalizeEmailForKey(dto.email)}`
    await this.enforceRateLimit(rateLimitKey, dto.email, ipAddress)

    const user = await this.findUserByEmail(dto.email)
    if (!user) {
      this.rateLimiter.recordAttempt(rateLimitKey)
      await this.logLoginAttempt(null, dto.email, false, ipAddress, 'email_not_found')
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng')
    }

    const passwordValid = await bcrypt.compare(dto.password, user.password_hash)
    if (!passwordValid) {
      this.rateLimiter.recordAttempt(rateLimitKey)
      await this.logLoginAttempt(user.id, dto.email, false, ipAddress, 'bad_password')
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng')
    }

    if (user.status !== 'active') {
      this.rateLimiter.recordAttempt(rateLimitKey)
      await this.logLoginAttempt(user.id, dto.email, false, ipAddress, 'account_locked')
      throw new UnauthorizedException('Tài khoản đã bị khoá')
    }

    // kiểm tra đăng nhập theo địa chỉ wifi văn phòng (BẤT KỲ văn
    // phòng nào đang active, KHÔNG riêng văn phòng được gán cho nhân viên — xem
    // JSDoc `login-wifi-check.helper.ts`). Kill-switch mặc định OFF ở CẢ env LẪN
    // Settings DB (`isLoginWifiCheckActive()`) → merge/deploy giữ nguyên hành vi cũ
    // 100%. KHÔNG tính vào rate-limit (không phải sai mật khẩu).
    if (await this.isLoginWifiCheckActive()) {
      const { grants } = await this.permissionService.grantsFor(user.id)
      const wifiCheck = await this.checkLoginWifi(user.id, dto.email, grants, ipAddress)
      if (!wifiCheck.allowed) {
        this.logger.warn(
          `[login-wifi-check] BLOCKED user=${user.id} email=${dto.email} ip=${ipAddress ?? 'unknown'} reason=${wifiCheck.reason}`,
        )
        await this.logLoginAttempt(user.id, dto.email, false, ipAddress, 'wifi_blocked')
        throw new UnauthorizedException(
          'Bạn đang không kết nối wifi của văn phòng công ty. Vui lòng kết nối wifi tại một trong các văn phòng rồi đăng nhập lại.',
        )
      }
      if (wifiCheck.reason.startsWith('fail_open')) {
        // Fail-open: KHÔNG chặn đăng nhập, nhưng PHẢI ghi log để phát hiện cấu
        // hình lỗi/DB chập chờn thay vì im lặng (quy tắc fail-open).
        this.logger.debug(
          `[login-wifi-check] fail-open user=${user.id} email=${dto.email} ip=${ipAddress ?? 'unknown'} reason=${wifiCheck.reason}`,
        )
      }
    }

    this.rateLimiter.resetAttempts(rateLimitKey)
    await this.logLoginAttempt(user.id, dto.email, true, ipAddress, 'ok')
    // Clear blacklist khi login thành công: nếu user vừa logout/đổi role rồi login lại
    // bằng password đúng, họ phải được full access ngay (status check ở trên đã chặn user bị lock).
    this.tokenBlacklist.removeUser(user.id)

    // "1 tài khoản chỉ 1 phiên đăng nhập": khi tính năng đang bật,
    // đăng ký phiên MỚI (ghi đè phiên cũ trong ActiveSessionService) → mọi token
    // cũ mang `sid` khác sẽ bị JwtAuthGuard/refresh() từ chối. Tắt (mặc định)
    // → KHÔNG gọi startSession, token KHÔNG có `sid` → 0 đổi hành vi (fail-open).
    const sid = (await this.isSingleSessionActive())
      ? this.activeSession.startSession(user.id)
      : undefined
    return this.buildTokenResponse(user, sid, crypto.randomUUID())
  }

  /**
   * Check IP client so với hợp NHẤT (union) IP của MỌI văn phòng đang active
   * (`attendance_offices.ips` — tái dùng nguyên bảng "văn phòng chấm công", KHÔNG
   * thêm bảng/cột mới). **KHÁC chấm công**: chấm công vẫn match ĐÚNG 1 văn phòng
   * được gán riêng cho nhân viên (`employees.office_id`, xem `attendance-ip.helper.ts`,
   * KHÔNG đổi) — đăng nhập KHÔNG cần nhân viên có văn phòng gán, chỉ cần IP khớp
   * BẤT KỲ văn phòng nào công ty đang bật.
   *
   * **danh sách ÁP DỤNG (opt-in enforcement):** kiểm tra IP CHỈ
   * chạy cho user nằm trong `login_wifi_check_targets` đã cấu hình (theo
   * Phòng/Team/Nhân viên — xem `login-wifi-check-targets.helper.ts`). User
   * KHÔNG nằm trong danh sách (kể cả khi danh sách RỖNG) → cho qua thẳng,
   * KHÔNG chạy union-IP-match bên dưới. Đây là opt-in CỐ Ý (chọn ai thì
   * người đó bị kiểm, không chọn thì thôi), KHÔNG cần fallback rộng ra.
   *
   * FAIL-OPEN TUYỆT ĐỐI — mọi nhánh không xác định được dữ liệu đều
   * trả `allowed:true`, chỉ khác nhau ở `reason` log:
   * - Không xác định được IP client → cho vào.
   * - KHÔNG văn phòng nào active có cấu hình IP (hệ thống chưa setup) → cho vào.
   * - Lỗi đọc DB (timeout, mất kết nối...) → cho vào (KHÔNG để lỗi hạ tầng biến
   *   thành khoá tài khoản hàng loạt).
   * CHỈ chặn khi có đủ dữ liệu 2 phía (IP client xác định được + có ít nhất 1 IP
   * văn phòng hợp lệ) và KHÔNG khớp bất kỳ văn phòng nào.
   */
  private async checkLoginWifi(
    userId: number,
    email: string,
    grants: Grants,
    ipAddress: string | null,
  ): Promise<{ allowed: boolean; reason: string }> {
    try {
      // PHẢI truyền user.id THẬT: `LOGIN_WIFI_CHECK_BYPASS_EMAILS` nhận CẢ email
      // LẪN user id dạng số (vd "123"). Truyền id giả (0) làm
      // nhánh bypass-theo-id im lặng không hoạt động → khoá đúng tài khoản vận
      // hành mà ops tưởng đã mở, đồng thời biến "0" trong CSV thành bypass TOÀN BỘ.
      if (isLoginWifiCheckBypassed({ id: userId, email, grants })) {
        return { allowed: true, reason: 'bypassed' }
      }
      // CHỈ áp dụng cho user nằm trong danh sách đã cấu hình.
      // Chạy SAU bypass (bypass luôn thắng) và TRƯỚC mọi bước IP-match bên
      // dưới (không targeted → không cần biết IP là gì). Hàm này tự fail-open
      // khi lỗi DB (trả `false`) — KHÔNG throw ra đây.
      const targeted = await resolveLoginWifiTargetedForUser(this.prisma, userId)
      if (!targeted) {
        return { allowed: true, reason: 'not_targeted' }
      }
      // Loopback/IP không xác định (vd reverse proxy quên set x-real-ip) KHÔNG được coi
      // là "sai văn phòng" — coi như không xác định được IP, fail-open (tránh 1
      // thay đổi hạ tầng ngoài code khoá TOÀN BỘ nhân viên cùng lúc). Check `ipAddress == null` riêng trước để TS narrow sang
      // `string` cho lời gọi `loginIpMatchesOffice` bên dưới (tránh non-null `!`).
      if (ipAddress == null || isUnusableLoginIp(ipAddress)) {
        return { allowed: true, reason: 'fail_open_no_usable_ip' }
      }

      // Loại văn phòng demo (`is_demo=true`) khỏi danh sách IP hợp lệ: văn phòng demo
      // không dùng để so IP (xem `AttendanceService.resolveOfficeForCheck`, cũng lọc
      // `!is_demo`). Đưa IP của nó vào union sẽ nới quyền đăng nhập ngoài ý định.
      const offices = await this.prisma.attendanceOffice.findMany({
        where: { is_active: true, is_demo: false },
        select: { ips: true },
      })
      const allOfficeIps = offices.flatMap((o) => o.ips)
      if (allOfficeIps.length === 0) {
        return { allowed: true, reason: 'fail_open_no_offices_configured' }
      }

      const matched = loginIpMatchesOffice(ipAddress, allOfficeIps)
      return {
        allowed: matched,
        reason: matched ? 'matched' : 'ip_mismatch:any_office',
      }
    } catch {
      // Lỗi DB/bất kỳ lỗi không lường trước → fail-open, KHÔNG khoá hàng loạt.
      return { allowed: true, reason: 'fail_open_error' }
    }
  }

  /**
   * Kill-switch tổng hợp — ENABLED khi env HOẶC Settings DB nói bật (OR, KHÔNG
   * AND): env dành cho ops (không cần đăng nhập UI), Settings DB dành cho
   * người có quyền settings.integrations tự bật/tắt không cần redeploy (
   * Lỗi đọc DB → fail-safe coi DB flag là TẮT (KHÔNG chặn login vì lỗi hạ tầng).
   */
  private async isLoginWifiCheckActive(): Promise<boolean> {
    if (isLoginWifiCheckEnabled()) return true
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: LOGIN_WIFI_CHECK_ENABLED_KEY },
        select: { value: true },
      })
      return row?.value === 'true'
    } catch (err) {
      this.logger.error(
        `isLoginWifiCheckActive DB read failed, fail-safe OFF: ${(err as Error)?.message}`,
      )
      return false
    }
  }

  /** GET /auth/settings/login-wifi-check — mọi role đọc được (transparency). */
  async getLoginWifiCheckConfig(): Promise<{ enabled: boolean; envForced: boolean }> {
    const envForced = isLoginWifiCheckEnabled()
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: LOGIN_WIFI_CHECK_ENABLED_KEY },
        select: { value: true },
      })
      return { enabled: row?.value === 'true', envForced }
    } catch (err) {
      this.logger.error(
        `getLoginWifiCheckConfig failed: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      )
      // Lỗi đọc KV → fail-safe hiện TẮT (khớp hành vi thật của isLoginWifiCheckActive).
      return { enabled: false, envForced }
    }
  }

  /** PATCH /auth/settings/login-wifi-check — cần quyền settings.integrations (gate ở controller). */
  async updateLoginWifiCheckConfig(
    enabled: boolean,
    userId: number,
  ): Promise<{ enabled: boolean }> {
    const value = enabled ? 'true' : 'false'
    try {
      await this.prisma.setting.upsert({
        where: { key: LOGIN_WIFI_CHECK_ENABLED_KEY },
        update: { value, updated_by: userId },
        create: { key: LOGIN_WIFI_CHECK_ENABLED_KEY, value, updated_by: userId },
      })
    } catch (err) {
      this.logger.error(
        `updateLoginWifiCheckConfig failed (user=${userId}): ${(err as Error)?.message}`,
        (err as Error)?.stack,
      )
      throw new InternalServerErrorException(
        'Không cập nhật được cấu hình đăng nhập theo wifi văn phòng',
      )
    }
    this.logger.log(
      `Login-wifi-check Settings config updated by user ${userId}: enabled=${enabled}`,
    )
    return { enabled }
  }

  /**
   * Kill-switch tổng hợp cho "1 tài khoản chỉ 1 phiên đăng nhập"
   * — mirror CHÍNH XÁC `isLoginWifiCheckActive()`: env HOẶC Settings DB (OR).
   * Lỗi đọc DB → fail-safe TẮT (KHÔNG tự bật 1 tính năng có thể đăng xuất
   * hàng loạt chỉ vì lỗi hạ tầng tạm thời).
   */
  private async isSingleSessionActive(): Promise<boolean> {
    if (isSingleSessionEnabled()) return true
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: SINGLE_SESSION_ENABLED_KEY },
        select: { value: true },
      })
      return row?.value === 'true'
    } catch (err) {
      this.logger.error(
        `isSingleSessionActive DB read failed, fail-safe OFF: ${(err as Error)?.message}`,
      )
      return false
    }
  }

  /** GET /auth/settings/single-session — mọi role đọc được (transparency). */
  async getSingleSessionConfig(): Promise<{ enabled: boolean; envForced: boolean }> {
    const envForced = isSingleSessionEnabled()
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: SINGLE_SESSION_ENABLED_KEY },
        select: { value: true },
      })
      return { enabled: row?.value === 'true', envForced }
    } catch (err) {
      this.logger.error(
        `getSingleSessionConfig failed: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      )
      return { enabled: false, envForced }
    }
  }

  /** PATCH /auth/settings/single-session — cần quyền settings.integrations (gate ở controller). */
  async updateSingleSessionConfig(
    enabled: boolean,
    userId: number,
  ): Promise<{ enabled: boolean }> {
    const value = enabled ? 'true' : 'false'
    try {
      await this.prisma.setting.upsert({
        where: { key: SINGLE_SESSION_ENABLED_KEY },
        update: { value, updated_by: userId },
        create: { key: SINGLE_SESSION_ENABLED_KEY, value, updated_by: userId },
      })
    } catch (err) {
      this.logger.error(
        `updateSingleSessionConfig failed (user=${userId}): ${(err as Error)?.message}`,
        (err as Error)?.stack,
      )
      throw new InternalServerErrorException(
        'Không cập nhật được cấu hình giới hạn 1 phiên đăng nhập',
      )
    }
    this.logger.log(
      `Single-session Settings config updated by user ${userId}: enabled=${enabled}`,
    )
    return { enabled }
  }

  /**
   * Login cho bên thứ 3 qua /public/auth/login. So với login thường:
   *  - KHÔNG trả refresh_token (bên thứ 3 phải call lại /public/auth/login sau khi hết hạn).
   *  - Chỉ cho phép user chính là owner của API key (`expectedOwnerUserId`) — chặn việc
   *    dùng 1 API key để login dưới user khác.
   *  - Re-check quyền `contacts.create` của
   *    user CÒN quyền lúc login (KHÔNG còn whitelist theo tên vai trò) — nếu
   *    quyền bị thu hồi sau khi mint key thì reject. Loại cả Quản trị
   *    (`isAdmin`) — mirror `ApiKeysService.assertOwnerUserActive`, JWT mint ở
   *    đây mang ĐÚNG quyền hiện có của owner, không giới hạn thêm.
   *  - Access token 15m để tương thích cách Gateway/guards verify JWT hiện tại,
   *    KHÔNG set `aud` (JwtAuthGuard downstream không verify audience — set vào
   *    gây hiểu lầm là có enforce).
   */
  async loginForThirdParty(
    dto: LoginDto,
    ipAddress: string | null,
    expectedOwnerUserId: number,
  ) {
    // mirror `login()`: key rate-limit chuẩn hoá để KHÔNG cho
    // biến thể hoa/thường của cùng email né quota brute-force (nhánh này LUÔN
    // enforce thật — khác nhánh nội bộ đang tắt, xem `rate-limiter.service.ts`).
    const rateLimitKey = `public-login:${ipAddress ?? 'unknown'}:${this.normalizeEmailForKey(dto.email)}`
    await this.enforceRateLimit(rateLimitKey, dto.email, ipAddress)

    const user = await this.findUserByEmail(dto.email)
    if (!user) {
      this.rateLimiter.recordAttempt(rateLimitKey)
      await this.logLoginAttempt(null, dto.email, false, ipAddress, 'email_not_found')
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng')
    }

    const passwordValid = await bcrypt.compare(dto.password, user.password_hash)
    if (!passwordValid) {
      this.rateLimiter.recordAttempt(rateLimitKey)
      await this.logLoginAttempt(user.id, dto.email, false, ipAddress, 'bad_password')
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng')
    }

    if (user.status !== 'active') {
      this.rateLimiter.recordAttempt(rateLimitKey)
      await this.logLoginAttempt(user.id, dto.email, false, ipAddress, 'account_locked')
      throw new UnauthorizedException('Tài khoản đã bị khoá')
    }

    if (user.id !== expectedOwnerUserId) {
      // API key cấp cho owner_user_id=X chỉ được đăng nhập dưới user X — tránh
      // dùng 1 key login lấy JWT của user khác (scope bypass).
      this.rateLimiter.recordAttempt(rateLimitKey)
      await this.logLoginAttempt(user.id, dto.email, false, ipAddress, 'owner_mismatch')
      throw new UnauthorizedException(
        'Email không khớp với owner của API key',
      )
    }

    const { grants, isAdmin } = await this.permissionService.grantsFor(user.id)
    if (isAdmin || !can(grants, 'contacts.create')) {
      this.rateLimiter.recordAttempt(rateLimitKey)
      await this.logLoginAttempt(user.id, dto.email, false, ipAddress, 'role_not_allowed')
      throw new UnauthorizedException(
        'Tài khoản này không được phép đăng nhập qua public API',
      )
    }

    this.rateLimiter.resetAttempts(rateLimitKey)
    await this.logLoginAttempt(user.id, dto.email, true, ipAddress, 'ok')
    this.tokenBlacklist.removeUser(user.id)

    const accessPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
    }
    const accessToken = this.jwtService.sign(accessPayload, {
      expiresIn: '15m',
    })

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 15 * 60,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        roles: user.user_roles.map((ur) => ur.role.name),
        team_id: user.team_id,
        team_name: user.team?.name ?? null,
      },
    }
  }

  async refresh(refreshToken: string) {
    const payload = this.verifyRefreshToken(refreshToken)
    const user = await this.findUserById(payload.sub)

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Tài khoản không hợp lệ hoặc đã bị khoá')
    }

    if (this.tokenBlacklist.isBlacklisted(user.id)) {
      throw new UnauthorizedException('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại')
    }

    // Token cấp trước lần đổi/reset mật khẩu gần nhất thì mất hiệu lực (kể cả sau khi user đăng nhập lại).
    const validAfter = user.tokens_valid_after?.getTime()
    if (validAfter !== undefined && (payload.iat ?? 0) * 1000 < validAfter) {
      throw new UnauthorizedException('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại')
    }

    // Phiên đã đăng xuất (thu hồi theo id phiên) thì không được làm mới nữa.
    if (payload.jti) {
      const revoked = await this.prisma.revokedSession.findUnique({
        where: { session_id: payload.jti },
        select: { session_id: true },
      })
      if (revoked) {
        throw new UnauthorizedException('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại')
      }
    }

    // refresh token mang `sid` của phiên ĐÃ bị 1 lần đăng nhập
    // khác thay thế → từ chối, buộc đăng nhập lại. Fail-open khi thiếu `sid`
    // hoặc chưa có phiên nào được theo dõi (xem JSDoc ActiveSessionService).
    if (!this.activeSession.isCurrentSession(user.id, payload.sid)) {
      throw new UnauthorizedException(
        'Tài khoản vừa đăng nhập ở nơi khác, phiên này đã bị đăng xuất',
      )
    }

    // Giữ NGUYÊN sid hiện tại của phiên (KHÔNG cấp sid mới) — refresh chỉ gia
    // hạn token, không phải một lần đăng nhập mới, nên không được tự thay thế
    // chính phiên đang hợp lệ của mình.
    return this.buildTokenResponse(user, payload.sid, payload.jti ?? crypto.randomUUID())
  }

  /**
   * Đăng xuất: thu hồi refresh token của CHÍNH phiên đó (theo id phiên `jti`, nên mọi token đã xoay vòng
   * của phiên cũng chết). Lưu DB để sống qua restart và nhiều instance. Không gửi refresh token thì chỉ
   * hết hiệu lực access token như trước.
   */
  async logout(userId: number, refreshToken?: string): Promise<{ message: string }> {
    if (refreshToken) {
      let payload: RefreshPayload | null = null
      try {
        payload = this.verifyRefreshToken(refreshToken)
      } catch {
        payload = null // token hỏng/hết hạn: không còn gì để thu hồi
      }
      if (payload && payload.sub === userId && payload.jti) {
        const expiresAt = new Date((payload.exp ?? Math.floor(Date.now() / 1000) + 7 * 86400) * 1000)
        await this.prisma.revokedSession.upsert({
          where: { session_id: payload.jti },
          create: { session_id: payload.jti, user_id: userId, expires_at: expiresAt },
          update: {},
        })
        // Dọn các dòng đã quá hạn refresh token (không còn tác dụng).
        await this.prisma.revokedSession.deleteMany({ where: { expires_at: { lt: new Date() } } })
      }
    }
    this.tokenBlacklist.blacklistUser(userId)
    // gỡ theo dõi phiên: lần login KẾ TIẾP (nếu tính năng đang
    // bật) sẽ fail-open cho tới khi có phiên mới, tránh mắc kẹt map ở sessionId
    // của phiên vừa chủ động đăng xuất.
    this.activeSession.clearUser(userId)
    return { message: 'Đăng xuất thành công' }
  }

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    ipAddress: string | null = null,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash)
    if (!valid) {
      throw new UnauthorizedException('Mật khẩu hiện tại không đúng')
    }

    const hash = await bcrypt.hash(newPassword, 10)
    await this.prisma.user.update({
      where: { id: userId },
      data: { password_hash: hash, password_updated_at: new Date(), tokens_valid_after: new Date() },
    })

    this.tokenBlacklist.blacklistUser(userId)
    await this.auditLog.logPasswordChange({
      actorUserId: userId,
      targetUserId: userId,
      method: 'self_change',
      ipAddress,
    })
    return { message: 'Đổi mật khẩu thành công' }
  }

  /**
   * Tự đặt lại bằng mật khẩu ngẫu nhiên. Phải xác thực lại bằng mật khẩu hiện tại
   * — chỉ có access token thì không đủ (token bị lấy cắp sẽ thành chiếm tài khoản lâu dài).
   */
  async resetMyPassword(userId: number, currentPassword: string, ipAddress: string | null = null) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }
    const valid = await bcrypt.compare(currentPassword ?? '', user.password_hash)
    if (!valid) {
      throw new UnauthorizedException('Mật khẩu hiện tại không đúng')
    }

    const newPassword = this.generatePassword(12)
    const hash = await bcrypt.hash(newPassword, 10)
    await this.prisma.user.update({
      where: { id: userId },
      data: { password_hash: hash, password_updated_at: new Date(), tokens_valid_after: new Date() },
    })

    this.tokenBlacklist.blacklistUser(userId)
    await this.auditLog.logPasswordChange({
      actorUserId: userId,
      targetUserId: userId,
      method: 'self_reset',
      ipAddress,
    })
    return { newPassword, message: 'Reset mật khẩu thành công' }
  }

  private generatePassword(length: number): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
    const special = '@#$%&*!'
    const bytes = crypto.randomBytes(length)
    let password = ''
    for (let i = 0; i < length - 1; i++) {
      password += chars[bytes[i] % chars.length]
    }
    password += special[bytes[length - 1] % special.length]
    return password
  }

  async updateProfile(userId: number, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }

    const data: Record<string, string> = {}
    if (dto.full_name !== undefined) data.full_name = dto.full_name
    if (dto.phone !== undefined) data.phone = dto.phone

    if (Object.keys(data).length === 0) {
      return { message: 'Không có thông tin cần cập nhật' }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data,
    })

    return { message: 'Cập nhật hồ sơ thành công' }
  }

  async uploadAvatar(userId: number, file: Express.Multer.File) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng')
    }
    if (!file) {
      throw new BadRequestException('Vui lòng chọn ảnh để upload')
    }

    this.validateAvatarFile(file)

    const store = createUploadsStore()

    const timestamp = Date.now()
    const fileName = `${userId}_${timestamp}.jpg`

    // mimetype do client khai: file giả ảnh làm sharp ném lỗi → 400, không phải 500
    let jpeg: Buffer
    try {
      jpeg = await sharp(file.buffer)
        .resize(200, 200, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toBuffer()
    } catch {
      throw new BadRequestException('Tệp không phải ảnh hợp lệ')
    }
    await store.save(`avatars/${fileName}`, jpeg, 'image/jpeg')

    const avatarUrl = `/uploads/avatars/${fileName}`
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatar_url: avatarUrl },
    })
    // Chỉ xoá ảnh cũ SAU khi ảnh mới đã lưu xong và DB đã trỏ sang ảnh mới
    await this.deleteOldAvatar(user.avatar_url)

    return { avatar_url: avatarUrl, message: 'Cập nhật ảnh đại diện thành công' }
  }

  private validateAvatarFile(file: Express.Multer.File): void {
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Định dạng ảnh không hợp lệ: ${file.mimetype}. Chỉ chấp nhận: JPG, PNG, WebP.`,
      )
    }
    const maxSize = 5 * 1024 * 1024
    if (file.size > maxSize) {
      throw new BadRequestException(
        `Ảnh quá lớn: ${(file.size / 1024 / 1024).toFixed(1)}MB. Tối đa 5MB.`,
      )
    }
  }

  private async deleteOldAvatar(avatarUrl: string | null): Promise<void> {
    const rel = uploadsRelPathFromUrl(avatarUrl)
    if (!rel || !rel.startsWith('avatars/')) return
    // best-effort: file có thể không tồn tại
    await createUploadsStore().remove(rel)
  }

  /**
   * Chuẩn hoá email CHỈ để build key rate-limit (trim + lowercase) — không
   * bao giờ dùng giá trị này cho lookup DB hay audit log (xem `findUserByEmail`
   * + `logLoginAttempt`, cả 2 PHẢI giữ nguyên chuỗi RAW người dùng gõ).
   */
  private normalizeEmailForKey(email: string): string {
    return email.trim().toLowerCase()
  }

  /**
   * Request bị rate-limit vẫn được ghi vào `audit_logs` để phân biệt
   * "bị chặn vì thử quá nhiều" với các nhánh 401 khác khi điều tra.
   */
  private async enforceRateLimit(
    key: string,
    email: string,
    ipAddress: string | null,
  ): Promise<void> {
    if (this.rateLimiter.isRateLimited(key)) {
      const retryAfter = this.rateLimiter.getRetryAfterSeconds(key)
      await this.logLoginAttempt(null, email, false, ipAddress, 'rate_limited')
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Quá nhiều lần thử, vui lòng thử lại sau',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }

  private async logLoginAttempt(
    userId: number | null,
    email: string,
    success: boolean,
    ipAddress: string | null,
    reason: LoginAttemptReason,
  ): Promise<void> {
    await this.auditLog.logLogin({ userId, email, success, ipAddress, reason })
  }

  /**
   * lookup email KHÔNG PHÂN BIỆT HOA/THƯỜNG. `findUnique`
   * không diễn tả được so sánh case-insensitive trên field `@unique` thường
   * (không phải `citext`) nên phải chuyển sang `findFirst` + `mode:'insensitive'`.
   * KHÔNG lowercase `email` trước khi truyền vào `equals` — Postgres ILIKE-style
   * so khớp không phân biệt hoa/thường ở tầng DB nên không cần chuẩn hoá phía
   * JS, và giữ nguyên input để không đánh mất khoảng trắng cần loại (không có
   * ở đây vì DTO này không trim — xem `LoginDto`).
   *
   * ⚠️ Vì `users.email` KHÔNG có ràng buộc unique KHÔNG PHÂN BIỆT hoa/thường ở
   * tầng DB (chỉ `@unique` thường, case-sensitive) — về mặt lý thuyết vẫn có
   * thể tồn tại 2 dòng khác nhau chỉ khác hoa/thường nếu tạo/sửa qua đường nào
   * đó KHÔNG chặn. `UsersService.create()`/`update()` (`users.service.ts`) đã
   * được gắn collision-check case-insensitive tương ứng để KHÔNG cho tình
   * huống này phát sinh mới — nếu nó từng xảy ra qua đường khác (vd thao tác
   * DB trực tiếp), `findFirst` PHẢI trả về CÙNG 1 dòng mỗi lần gọi (không thì
   * cùng 1 email có thể login vào tài khoản KHÁC nhau tuỳ lần) — Postgres
   * KHÔNG đảm bảo thứ tự khi thiếu `ORDER BY`, nên chốt `orderBy: { id: 'asc' }`
   * (luôn ưu tiên tài khoản TẠO TRƯỚC — bản gốc — nếu có collision) thay vì để
   * mặc định phụ thuộc query planner. Đây là phòng thủ chiều sâu, không đổi
   * hành vi khi không có trùng.
   */
  private async findUserByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      orderBy: { id: 'asc' },
      include: {
        team: true,
        user_roles: { include: { role: true } },
      },
    })
  }

  private async findUserById(id: number): Promise<UserWithRole | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        team: true,
        user_roles: { include: { role: true } },
      },
    })
  }

  private async buildTokenResponse(user: UserWithRole, sid?: string, sessionId?: string) {
    const accessPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      ...(sid ? { sid } : {}),
    }
    const refreshPayload: RefreshPayload = {
      sub: user.id,
      type: 'refresh',
      ...(sid ? { sid } : {}),
      ...(sessionId ? { jti: sessionId } : {}),
    }

    const accessToken = this.jwtService.sign(accessPayload, { expiresIn: '15m' })
    const refreshToken = this.jwtService.sign(refreshPayload, { expiresIn: '7d' })

    // — FE có `permissions`/`isAdmin` NGAY từ response login/refresh,
    // không cần gọi thêm `/auth/me`.
    const { grants, isAdmin } = await this.permissionService.grantsFor(user.id)
    const me = this.toMeResponse(user, grants, isAdmin)

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...me,
    }
  }

  private verifyRefreshToken(token: string): RefreshPayload {
    try {
      const payload = this.jwtService.verify<RefreshPayload>(token)
      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Token không hợp lệ')
      }
      return payload
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err
      throw new UnauthorizedException('Refresh token không hợp lệ hoặc đã hết hạn')
    }
  }
}
