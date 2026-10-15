import { Test, TestingModule } from '@nestjs/testing'
import { JwtService } from '@nestjs/jwt'
import { UnauthorizedException, NotFoundException, HttpException } from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import { PrismaService } from '@trinity/prisma'
import { AuthService } from './auth.service'
import { RateLimiterService } from './services/rate-limiter.service'
import { TokenBlacklistService, PermissionService } from '@trinity/rbac-nest'
import { AuditLogService } from './services/audit-log.service'
import { ActiveSessionService } from '@trinity/rbac-nest'

jest.mock('bcryptjs')

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  employee: {
    findUnique: jest.fn(),
  },
  revokedSession: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  attendanceOffice: {
    findMany: jest.fn(),
  },
  setting: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  loginWifiCheckTarget: {
    findMany: jest.fn(),
  },
}

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock-token'),
  verify: jest.fn(),
}

const mockAuditLog = {
  logLogin: jest.fn().mockResolvedValue(undefined),
  logPasswordChange: jest.fn().mockResolvedValue(undefined),
}

// RBAC quyền + phạm vi — mock PermissionService, KHÔNG chạy query
// Prisma thật (`grantsFor` đã có test riêng ở packages/rbac-nest). Mặc định
// rỗng/isAdmin=false — test nào cần grants cụ thể tự override qua
// mockResolvedValueOnce.
const mockPermissionService = {
  grantsFor: jest.fn().mockResolvedValue({ grants: {}, isAdmin: false }),
}

describe('AuthService', () => {
  let service: AuthService
  let rateLimiter: RateLimiterService
  let tokenBlacklist: TokenBlacklistService
  let activeSession: ActiveSessionService

  const mockUser = {
    id: 1,
    email: 'test@example.vn',
    password_hash: 'hashed-password',
    full_name: 'Test User',
    team_id: 1,
    status: 'active',
    team: { name: 'Team A' },
    user_roles: [{ role: { name: 'Nhân viên kinh doanh', permissions: [] } }],
  }

  beforeEach(async () => {
    jest.clearAllMocks()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        RateLimiterService,
        TokenBlacklistService,
        ActiveSessionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: PermissionService, useValue: mockPermissionService },
      ],
    }).compile()

    service = module.get<AuthService>(AuthService)
    rateLimiter = module.get<RateLimiterService>(RateLimiterService)
    tokenBlacklist = module.get<TokenBlacklistService>(TokenBlacklistService)
    activeSession = module.get<ActiveSessionService>(ActiveSessionService)
    rateLimiter.clear()
    tokenBlacklist.clear()
    activeSession.clear()
    mockPrisma.setting.findUnique.mockResolvedValue(null)
  })

  describe('login', () => {
    it('should return tokens on valid credentials', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.login(
        { email: 'test@example.vn', password: 'password123' },
        '127.0.0.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(result).toHaveProperty('refresh_token')
      expect(result.user.email).toBe('test@example.vn')
      // RBAC quyền + phạm vi — response KHÔNG còn `user.role`
      // (1 vai trò cố định); thay bằng `roles[]` + `permissions` (Grants).
      expect(result.roles).toEqual([{ id: undefined, name: 'Nhân viên kinh doanh', is_system: undefined }])
      expect(result.permissions).toEqual({})
      expect(result.isAdmin).toBe(false)
    })

    it('should throw 401 on invalid email', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)

      await expect(
        service.login({ email: 'wrong@example.vn', password: 'pass' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('should throw 401 on invalid password', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(false)

      await expect(
        service.login({ email: 'test@example.vn', password: 'wrong' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('should throw 401 on locked account', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ ...mockUser, status: 'locked' })
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      await expect(
        service.login({ email: 'test@example.vn', password: 'password123' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('should throw 429 after 5 failed attempts', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)

      for (let i = 0; i < 5; i++) {
        await service.login({ email: 'test@example.vn', password: 'wrong' }, '127.0.0.1')
          .catch(() => { /* expected */ })
      }

      await expect(
        service.login({ email: 'test@example.vn', password: 'wrong' }, '127.0.0.1'),
      ).rejects.toThrow(HttpException)
    })

    it('should log login attempt to audit log', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      await service.login(
        { email: 'test@example.vn', password: 'password123' },
        '192.168.1.1',
      )

      expect(mockAuditLog.logLogin).toHaveBeenCalledWith({
        userId: 1,
        email: 'test@example.vn',
        success: true,
        ipAddress: '192.168.1.1',
        reason: 'ok',
      })
    })

    it('should clear blacklist on successful login (re-login after logout)', async () => {
      // Giả lập: user vừa logout (đã bị blacklist), giờ login lại bằng password đúng
      tokenBlacklist.blacklistUser(1)
      expect(tokenBlacklist.isBlacklisted(1)).toBe(true)

      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      const removeSpy = jest.spyOn(tokenBlacklist, 'removeUser')

      await service.login(
        { email: 'test@example.vn', password: 'password123' },
        '127.0.0.1',
      )

      expect(removeSpy).toHaveBeenCalledWith(1)
      expect(tokenBlacklist.isBlacklisted(1)).toBe(false)
    })
  })

  // Email trên field `@unique` thường (KHÔNG citext) nên lookup phải so khớp không phân biệt
  // hoa/thường (bàn phím điện thoại có thể tự viết hoa chữ cái đầu). Nhóm test này pin CẢ HAI đầu:
  // (a) lookup phải KHÔNG PHÂN BIỆT hoa/thường, (b) KHÔNG được lowercase email
  // đầu vào rồi so sánh — vì có user mang email ĐÃ LƯU có chữ hoa, và ép lowercase input sẽ KHÔNG BAO GIỜ khớp lại được
  // giá trị hoa đó nếu lookup vẫn exact-match ở phía DB.
  describe('login — case-insensitive email lookup', () => {
    it('đăng nhập được khi input khớp CHÍNH XÁC casing đã lưu', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.login(
        { email: 'test@example.vn', password: 'password123' },
        '127.0.0.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { equals: 'test@example.vn', mode: 'insensitive' } },
        }),
      )
    })

    it('đăng nhập được khi input VIẾT HOA khác casing đã lưu ', async () => {
      // Stored email: 'test@example.vn' (chữ thường). Điện thoại tự viết hoa
      // chữ cái đầu → gửi lên 'Test@example.vn'. Mock giả lập DB thật: Prisma
      // `mode:'insensitive'` sẽ trả về user dù input khác casing.
      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.login(
        { email: 'Test@example.vn', password: 'password123' },
        '127.0.0.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(result.user.email).toBe('test@example.vn') // trả về giá trị LƯU trong DB, không phải input
    })

    // ⚠️ PIN QUAN TRỌNG NHẤT: user có email ĐÃ
    // LƯU chứa chữ hoa (vd 'Alice@example.com'). Nếu fix case-insensitive
    // vô tình lowercase input rồi so sánh bằng exact-match, họ sẽ VĨNH VIỄN
    // không đăng nhập được nữa (input thường hoá không bao giờ khớp DB hoa)
    // đây là regression nguy hiểm nhất nếu làm sai.
    it('user có email ĐÃ LƯU chứa chữ hoa (dữ liệu cũ) vẫn đăng nhập được dù gõ chữ thường', async () => {
      const upperCaseStoredUser = { ...mockUser, id: 11, email: 'Alice@example.com' }
      mockPrisma.user.findFirst.mockResolvedValue(upperCaseStoredUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.login(
        { email: 'alice@example.com', password: 'password123' },
        '127.0.0.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(result.user.email).toBe('Alice@example.com')
      // Lookup phải truyền NGUYÊN input (KHÔNG lowercase trước) — mode:'insensitive'
      // là thứ làm việc so khớp, không phải chuẩn hoá JS phía trước.
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { equals: 'alice@example.com', mode: 'insensitive' } },
        }),
      )
    })

    it('user có email ĐÃ LƯU chứa chữ hoa vẫn đăng nhập được dù gõ ĐÚNG casing đã lưu', async () => {
      const upperCaseStoredUser = { ...mockUser, id: 12, email: 'Bob@example.com' }
      mockPrisma.user.findFirst.mockResolvedValue(upperCaseStoredUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.login(
        { email: 'Bob@example.com', password: 'password123' },
        '127.0.0.1',
      )

      expect(result).toHaveProperty('access_token')
    })

    it('vẫn thất bại 401 với lỗi gõ sai domain (exmaple thay vì example) — không liên quan casing', async () => {
      // findFirst mode:'insensitive' trả null vì domain THẬT SỰ khác, không
      // liên quan hoa/thường — phải phân biệt "case mismatch" (sửa được bằng
      //) với "typo thật" (vẫn phải 401, không được lỏng tay thêm fuzzy-match).
      mockPrisma.user.findFirst.mockResolvedValue(null)

      await expect(
        service.login({ email: 'carol@example.com', password: 'password123' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('vẫn thất bại 401 khi thiếu TLD (.com thay vì .com.vn) — không liên quan casing', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)

      await expect(
        service.login({ email: 'carol@example.org', password: 'password123' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('thông báo lỗi VẪN chung chung "Email hoặc mật khẩu không đúng" — không phân biệt email-not-found vs sai mật khẩu (chống dò email)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)

      await expect(
        service.login({ email: 'khongtontai@example.com', password: 'password123' }, '127.0.0.1'),
      ).rejects.toThrow('Email hoặc mật khẩu không đúng')

      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(false)

      await expect(
        service.login({ email: 'test@example.vn', password: 'sai-mat-khau' }, '127.0.0.1'),
      ).rejects.toThrow('Email hoặc mật khẩu không đúng')
    })
  })

  // audit trail phải phân biệt được NGUYÊN NHÂN thất bại (không chỉ {email, success}).
  // Pin từng nhánh ghi ĐÚNG `reason`.
  describe('login — audit reason', () => {
    it('email không tồn tại → reason=email_not_found', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)

      await service.login(
        { email: 'khongtontai@example.com', password: 'password123' },
        '127.0.0.1',
      ).catch(() => { /* expected 401 */ })

      expect(mockAuditLog.logLogin).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'email_not_found', success: false }),
      )
    })

    it('sai mật khẩu → reason=bad_password', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(false)

      await service.login(
        { email: 'test@example.vn', password: 'sai' },
        '127.0.0.1',
      ).catch(() => { /* expected 401 */ })

      expect(mockAuditLog.logLogin).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'bad_password', success: false }),
      )
    })

    it('tài khoản bị khoá → reason=account_locked', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ ...mockUser, status: 'locked' })
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      await service.login(
        { email: 'test@example.vn', password: 'password123' },
        '127.0.0.1',
      ).catch(() => { /* expected 401 */ })

      expect(mockAuditLog.logLogin).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'account_locked', success: false }),
      )
    })

    it('bị chặn wifi văn phòng (đang bật) → reason=wifi_blocked', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      try {
        mockPrisma.user.findFirst.mockResolvedValue(mockUser)
        ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
        mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])
        // mockUser PHẢI nằm trong danh sách áp dụng, nếu không
        // wifi check bị bỏ qua hoàn toàn (opt-in) và test này không còn ý nghĩa.
        mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([
          { scope_type: 'user', target_user_id: mockUser.id },
        ])
        mockPrisma.user.findUnique.mockResolvedValue({
          id: mockUser.id,
          manager_id: null,
          manager: null,
        })

        await service.login(
          { email: 'test@example.vn', password: 'password123' },
          '198.51.100.1',
        ).catch(() => { /* expected 401 */ })

        expect(mockAuditLog.logLogin).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'wifi_blocked', success: false }),
        )
      } finally {
        delete process.env.LOGIN_WIFI_CHECK_ENABLED
        mockPrisma.attendanceOffice.findMany.mockReset()
        mockPrisma.loginWifiCheckTarget.findMany.mockReset()
        mockPrisma.user.findUnique.mockReset()
      }
    })

    it('rate_limited chỉ enforce thật ở public-login (loginForThirdParty) — ghi reason=rate_limited khi vượt quota', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)

      // PUBLIC_MAX_ATTEMPTS = 5 (rate-limiter.service.ts) — chạm ngưỡng rồi thử lần thứ 6.
      for (let i = 0; i < 5; i++) {
        await service.loginForThirdParty(
          { email: 'khongtontai@example.com', password: 'password123' },
          '10.0.0.9',
          999,
        ).catch(() => { /* expected 401 email_not_found */ })
      }

      await expect(
        service.loginForThirdParty(
          { email: 'khongtontai@example.com', password: 'password123' },
          '10.0.0.9',
          999,
        ),
      ).rejects.toThrow(HttpException)

      expect(mockAuditLog.logLogin).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'rate_limited', success: false }),
      )
    })

    // rate-limit key chuẩn hoá (trim+lowercase) CHỈ để build
    // key, KHÔNG đổi giá trị `email` ghi audit (vẫn RAW). Case-variant của
    // CÙNG 1 email không được né quota bằng cách đổi hoa/thường lúc gửi.
    it('rate-limit key KHÔNG phân biệt hoa/thường — case-variant cùng email dùng CHUNG 1 quota (loginForThirdParty)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)

      const variants = [
        'Khongtontai@example.com',
        'KHONGTONTAI@example.com',
        'khongtontai@EXAMPLE.com',
        'khongtontai@example.com',
        'kHoNgToNtAi@example.com',
      ]
      for (const email of variants) {
        await service.loginForThirdParty(
          { email, password: 'password123' },
          '10.0.0.10',
          999,
        ).catch(() => { /* expected 401 email_not_found */ })
      }

      // Lần thứ 6 (bất kỳ casing nào) phải bị 429 vì CÙNG 1 quota bucket.
      await expect(
        service.loginForThirdParty(
          { email: 'KhongTonTai@example.com', password: 'password123' },
          '10.0.0.10',
          999,
        ),
      ).rejects.toThrow(HttpException)
    })
  })

  // login theo địa chỉ wifi văn phòng. Kill-switch mặc định OFF
  // (env VÀ Settings DB): các test "flag off" chứng minh merge KHÔNG đổi hành
  // vi đăng nhập hiện tại. match BẤT KỲ văn phòng active
  // nào (KHÔNG còn riêng văn phòng gán cho nhân viên) — mockPrisma.setting mặc
  // định trả `undefined` (findUnique chưa mock) → DB flag luôn coi là tắt trừ
  // khi test tự set mockResolvedValue.
  describe('login — wifi check', () => {
    const ORIGINAL_ENABLED = process.env.LOGIN_WIFI_CHECK_ENABLED
    const ORIGINAL_BYPASS = process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS

    const officeUser = {
      ...mockUser,
      id: 42,
      email: 'nv-vanphong@example.vn',
    }

    // MẶC ĐỊNH cho CẢ block này: officeUser NẰM TRONG danh sách
    // áp dụng (scope 'user' trỏ đúng id 42), để MỌI test đã có ở trên (viết
    // TRƯỚC, giả định "bật công tắc = áp dụng cho mọi người") tiếp tục
    // đúng như cũ mà KHÔNG cần sửa từng test — chỉ nhóm test MỚI bên dưới mới
    // tự override 2 mock này để kiểm ngữ nghĩa opt-in thật sự.
    beforeEach(() => {
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([
        { scope_type: 'user', target_user_id: officeUser.id },
      ])
      mockPrisma.user.findUnique.mockResolvedValue({
        id: officeUser.id,
        manager_id: null,
        manager: null,
      })
    })

    afterEach(() => {
      // `jest.clearAllMocks()` KHÔNG xoá implementation (chỉ xoá calls) → nếu 1
      // test set `setting.findUnique` trả `{value:'true'}` thì cờ DB sẽ RÒ sang
      // các test sau, làm test "cờ TẮT" mất ý nghĩa. Reset tường minh.
      mockPrisma.setting.findUnique.mockReset()
      mockPrisma.loginWifiCheckTarget.findMany.mockReset()
      mockPrisma.user.findUnique.mockReset()
      if (ORIGINAL_ENABLED === undefined) delete process.env.LOGIN_WIFI_CHECK_ENABLED
      else process.env.LOGIN_WIFI_CHECK_ENABLED = ORIGINAL_ENABLED
      if (ORIGINAL_BYPASS === undefined) delete process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS
      else process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS = ORIGINAL_BYPASS
    })

    it('cờ TẮT (mặc định, env + DB) — mọi tài khoản đăng nhập được dù IP bất kỳ', async () => {
      delete process.env.LOGIN_WIFI_CHECK_ENABLED
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        '9.9.9.9',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ TẮT ở env NHƯNG BẬT ở Settings DB — vẫn kiểm tra IP (OR logic)', async () => {
      delete process.env.LOGIN_WIFI_CHECK_ENABLED
      mockPrisma.setting.findUnique.mockResolvedValue({ value: 'true' })
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])

      await expect(
        service.login({ email: officeUser.email, password: 'password123' }, '198.51.100.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('cờ BẬT + IP khớp BẤT KỲ văn phòng active nào (KHÔNG cần gán riêng) — đăng nhập được', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([
        { ips: ['203.0.113.10'] },
        { ips: ['203.0.113.20'] },
      ])

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        '203.0.113.20',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.employee.findUnique).not.toHaveBeenCalled()
      expect(mockPrisma.attendanceOffice.findMany).toHaveBeenCalledWith({
        // is_demo=false: văn phòng demo (chấm công thử) KHÔNG được cấp quyền
        // đăng nhập cho mọi nhân viên ở IP đó.
        where: { is_active: true, is_demo: false },
        select: { ips: true },
      })
    })

    it('cờ BẬT + user id (số) nằm trong LOGIN_WIFI_CHECK_BYPASS_EMAILS — VẪN đăng nhập được dù IP sai', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      // officeUser.id = 42 — bypass theo ID số, KHÔNG theo email.
      process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS = '42'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ BẬT + user id KHÔNG nằm trong danh sách bypass — vẫn bị chặn (không bypass toàn cục do id giả)', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS = '0,298'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])

      await expect(
        service.login({ email: officeUser.email, password: 'password123' }, '198.51.100.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('cờ BẬT + IP KHÔNG khớp văn phòng active nào — bị chặn 401', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])

      await expect(
        service.login({ email: officeUser.email, password: 'password123' }, '198.51.100.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('cờ BẬT + user có quyền settings.integrations, IP SAI — VẪN đăng nhập được (bypass theo quyền)', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPermissionService.grantsFor
        .mockResolvedValueOnce({ grants: { 'settings.integrations': true }, isAdmin: false })
        .mockResolvedValueOnce({ grants: { 'settings.integrations': true }, isAdmin: false })

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
      // Bypass theo quyền → không cần đọc cấu hình văn phòng.
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ BẬT + Quản trị (isAdmin) IP SAI — VẪN đăng nhập được (mọi quyền = true/all)', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPermissionService.grantsFor
        .mockResolvedValueOnce({ grants: { 'settings.integrations': 'all' }, isAdmin: true })
        .mockResolvedValueOnce({ grants: { 'settings.integrations': 'all' }, isAdmin: true })

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ BẬT + IP loopback (127.0.0.1, vd reverse proxy quên set x-real-ip) — fail-open, KHÔNG chặn hàng loạt', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        '127.0.0.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ BẬT + email trong LOGIN_WIFI_CHECK_BYPASS_EMAILS — VẪN đăng nhập được dù IP sai', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS = 'user1@example.com, other@x.vn'
      const bypassUser = { ...officeUser, email: 'user1@example.com' }
      mockPrisma.user.findFirst.mockResolvedValue(bypassUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.login(
        { email: bypassUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ BẬT + KHÔNG văn phòng nào active có cấu hình IP — fail-open, vẫn vào được', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([])

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
    })

    it('cờ BẬT + văn phòng active có ips=[] (chưa cấu hình) bị loại khỏi hợp nhất — fail-open nếu đó là văn phòng DUY NHẤT', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: [] }])

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
    })

    it('cờ BẬT + KHÔNG xác định được IP client (null) — fail-open, vẫn vào được', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        null,
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ BẬT + lỗi đọc DB cấu hình văn phòng — fail-open, vẫn vào được (KHÔNG khoá hàng loạt)', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(officeUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.attendanceOffice.findMany.mockRejectedValue(new Error('DB timeout'))

      const result = await service.login(
        { email: officeUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
    })
  })

  describe('login — danh sách áp dụng (opt-in enforcement) cho wifi check', () => {
    const ORIGINAL_ENABLED = process.env.LOGIN_WIFI_CHECK_ENABLED

    const targetUser = { ...mockUser, id: 77, email: 'nv-team@example.vn' }

    afterEach(() => {
      mockPrisma.setting.findUnique.mockReset()
      mockPrisma.loginWifiCheckTarget.findMany.mockReset()
      mockPrisma.user.findUnique.mockReset()
      if (ORIGINAL_ENABLED === undefined) delete process.env.LOGIN_WIFI_CHECK_ENABLED
      else process.env.LOGIN_WIFI_CHECK_ENABLED = ORIGINAL_ENABLED
    })

    it('cờ BẬT + danh sách RỖNG (chưa chọn ai) — KHÔNG ai bị áp dụng, đăng nhập được dù IP sai (opt-in)', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(targetUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([])
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])

      const result = await service.login(
        { email: targetUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ BẬT + user KHÔNG nằm trong danh sách (có target khác) — không bị áp dụng, đăng nhập được dù IP sai', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(targetUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([
        { scope_type: 'user', target_user_id: 999 },
      ])
      mockPrisma.user.findUnique.mockResolvedValue({ id: targetUser.id, manager_id: null, manager: null })
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])

      const result = await service.login(
        { email: targetUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ BẬT + user được chọn TRỰC TIẾP (scope "user") + IP sai — bị chặn', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(targetUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([
        { scope_type: 'user', target_user_id: targetUser.id },
      ])
      mockPrisma.user.findUnique.mockResolvedValue({ id: targetUser.id, manager_id: null, manager: null })
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])

      await expect(
        service.login({ email: targetUser.email, password: 'password123' }, '198.51.100.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('cờ BẬT + user báo cáo trực tiếp cho 1 team_lead đã chọn (scope "team") + IP sai — bị chặn', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      const teamLeadId = 501
      mockPrisma.user.findFirst.mockResolvedValue(targetUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([
        { scope_type: 'team', target_user_id: teamLeadId },
      ])
      mockPrisma.user.findUnique.mockResolvedValue({
        id: targetUser.id,
        manager_id: teamLeadId,
        manager: { manager_id: 601 },
      })
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])

      await expect(
        service.login({ email: targetUser.email, password: 'password123' }, '198.51.100.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('cờ BẬT + user thuộc subtree 2 cấp của 1 Phòng (quản lý phòng) đã chọn (scope "department") + IP sai — bị chặn', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      const deptHeadId = 601
      mockPrisma.user.findFirst.mockResolvedValue(targetUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([
        { scope_type: 'department', target_user_id: deptHeadId },
      ])
      // targetUser (sale) → manager (team_lead, id 501) → manager.manager_id = deptHeadId (Phòng).
      mockPrisma.user.findUnique.mockResolvedValue({
        id: targetUser.id,
        manager_id: 501,
        manager: { manager_id: deptHeadId },
      })
      mockPrisma.attendanceOffice.findMany.mockResolvedValue([{ ips: ['203.0.113.10'] }])

      await expect(
        service.login({ email: targetUser.email, password: 'password123' }, '198.51.100.1'),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('cờ BẬT + lỗi đọc bảng danh sách áp dụng — fail-open, KHÔNG áp dụng (bỏ qua IP-match, không khoá hàng loạt)', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(targetUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.loginWifiCheckTarget.findMany.mockRejectedValue(new Error('DB timeout'))

      const result = await service.login(
        { email: targetUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })

    it('cờ BẬT + user có settings.integrations nằm trong danh sách áp dụng + IP sai — VẪN đăng nhập được (bypass thắng trước khi xét danh sách)', async () => {
      process.env.LOGIN_WIFI_CHECK_ENABLED = 'true'
      mockPrisma.user.findFirst.mockResolvedValue(targetUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([
        { scope_type: 'user', target_user_id: targetUser.id },
      ])
      mockPermissionService.grantsFor
        .mockResolvedValueOnce({ grants: { 'settings.integrations': true }, isAdmin: false })
        .mockResolvedValueOnce({ grants: { 'settings.integrations': true }, isAdmin: false })

      const result = await service.login(
        { email: targetUser.email, password: 'password123' },
        '198.51.100.1',
      )

      expect(result).toHaveProperty('access_token')
      // Bypass thắng TRƯỚC bước xét danh sách → không cần đọc bảng target.
      expect(mockPrisma.loginWifiCheckTarget.findMany).not.toHaveBeenCalled()
      expect(mockPrisma.attendanceOffice.findMany).not.toHaveBeenCalled()
    })
  })

  // công tắc Settings DB super_admin bật/tắt.
  describe('getLoginWifiCheckConfig / updateLoginWifiCheckConfig', () => {
    it('getLoginWifiCheckConfig: DB chưa có row → enabled=false, envForced theo env hiện tại', async () => {
      mockPrisma.setting.findUnique.mockResolvedValue(null)
      const result = await service.getLoginWifiCheckConfig()
      expect(result.enabled).toBe(false)
    })

    it('getLoginWifiCheckConfig: DB value=true → enabled=true', async () => {
      mockPrisma.setting.findUnique.mockResolvedValue({ value: 'true' })
      const result = await service.getLoginWifiCheckConfig()
      expect(result.enabled).toBe(true)
    })

    it('getLoginWifiCheckConfig: lỗi đọc DB → fail-safe enabled=false (KHÔNG throw)', async () => {
      mockPrisma.setting.findUnique.mockRejectedValue(new Error('DB down'))
      const result = await service.getLoginWifiCheckConfig()
      expect(result.enabled).toBe(false)
    })

    it('updateLoginWifiCheckConfig: upsert đúng key + value + updated_by', async () => {
      mockPrisma.setting.upsert.mockResolvedValue({})
      const result = await service.updateLoginWifiCheckConfig(true, 7)
      expect(result.enabled).toBe(true)
      expect(mockPrisma.setting.upsert).toHaveBeenCalledWith({
        where: { key: 'login_wifi_check_enabled' },
        update: { value: 'true', updated_by: 7 },
        create: { key: 'login_wifi_check_enabled', value: 'true', updated_by: 7 },
      })
    })

    it('updateLoginWifiCheckConfig: lỗi ghi DB → ném InternalServerErrorException', async () => {
      mockPrisma.setting.upsert.mockRejectedValue(new Error('DB down'))
      await expect(service.updateLoginWifiCheckConfig(true, 7)).rejects.toThrow()
    })
  })

  // mirror bộ test wifi-check ở trên, đổi key.
  describe('getSingleSessionConfig / updateSingleSessionConfig', () => {
    it('getSingleSessionConfig: DB chưa có row → enabled=false', async () => {
      mockPrisma.setting.findUnique.mockResolvedValue(null)
      const result = await service.getSingleSessionConfig()
      expect(result.enabled).toBe(false)
    })

    it('getSingleSessionConfig: DB value=true → enabled=true', async () => {
      mockPrisma.setting.findUnique.mockResolvedValue({ value: 'true' })
      const result = await service.getSingleSessionConfig()
      expect(result.enabled).toBe(true)
    })

    it('getSingleSessionConfig: lỗi đọc DB → fail-safe enabled=false (KHÔNG throw)', async () => {
      mockPrisma.setting.findUnique.mockRejectedValue(new Error('DB down'))
      const result = await service.getSingleSessionConfig()
      expect(result.enabled).toBe(false)
    })

    it('updateSingleSessionConfig: upsert đúng key + value + updated_by', async () => {
      mockPrisma.setting.upsert.mockResolvedValue({})
      const result = await service.updateSingleSessionConfig(true, 7)
      expect(result.enabled).toBe(true)
      expect(mockPrisma.setting.upsert).toHaveBeenCalledWith({
        where: { key: 'single_session_enabled' },
        update: { value: 'true', updated_by: 7 },
        create: { key: 'single_session_enabled', value: 'true', updated_by: 7 },
      })
    })

    it('updateSingleSessionConfig: lỗi ghi DB → ném InternalServerErrorException', async () => {
      mockPrisma.setting.upsert.mockRejectedValue(new Error('DB down'))
      await expect(service.updateSingleSessionConfig(true, 7)).rejects.toThrow()
    })
  })

  describe('phiên đăng nhập: thu hồi refresh token', () => {
    const refreshSignPayload = () =>
      mockJwtService.sign.mock.calls.map((c) => c[0]).find((p) => p.type === 'refresh')

    it('login cấp refresh token mang jti (id phiên); refresh giữ NGUYÊN jti đó', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      await service.login({ email: 'test@example.vn', password: 'password123' }, '127.0.0.1')
      const jti = refreshSignPayload().jti
      expect(typeof jti).toBe('string')
      expect(jti.length).toBeGreaterThan(10)

      mockJwtService.sign.mockClear()
      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh', jti })
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      mockPrisma.revokedSession.findUnique.mockResolvedValue(null)
      await service.refresh('t')
      expect(refreshSignPayload().jti).toBe(jti)
    })

    it('đăng xuất thu hồi phiên của chính refresh token đó (lưu jti + hạn token) và dọn dòng quá hạn', async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600
      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh', jti: 'sess-A', exp })
      mockPrisma.revokedSession.upsert.mockResolvedValue({})
      mockPrisma.revokedSession.deleteMany.mockResolvedValue({ count: 0 })

      await service.logout(1, 'refresh-token-A')

      expect(mockPrisma.revokedSession.upsert).toHaveBeenCalledWith({
        where: { session_id: 'sess-A' },
        create: { session_id: 'sess-A', user_id: 1, expires_at: new Date(exp * 1000) },
        update: {},
      })
      expect(mockPrisma.revokedSession.deleteMany).toHaveBeenCalled()
    })

    it('refresh bằng token của phiên đã đăng xuất → 401, kể cả sau khi user đăng nhập lại (blacklist đã xoá)', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh', jti: 'sess-A' })
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      mockPrisma.revokedSession.findUnique.mockResolvedValue({ session_id: 'sess-A' })
      tokenBlacklist.removeUser(1) // login mới đã xoá blacklist trong RAM

      await expect(service.refresh('refresh-token-A')).rejects.toThrow(UnauthorizedException)
      expect(mockPrisma.revokedSession.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { session_id: 'sess-A' } }),
      )
    })

    it('đăng xuất một phiên KHÔNG thu hồi phiên khác (jti khác vẫn refresh được)', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh', jti: 'sess-B' })
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      mockPrisma.revokedSession.findUnique.mockResolvedValue(null)
      await expect(service.refresh('refresh-token-B')).resolves.toHaveProperty('access_token')
    })

    it('logout không kèm refresh token, token của user khác hoặc token hỏng → không ghi thu hồi', async () => {
      mockPrisma.revokedSession.upsert.mockClear()
      await service.logout(1)
      mockJwtService.verify.mockReturnValue({ sub: 2, type: 'refresh', jti: 'x' })
      await service.logout(1, 'token-cua-nguoi-khac')
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('bad')
      })
      await service.logout(1, 'hong')
      expect(mockPrisma.revokedSession.upsert).not.toHaveBeenCalled()
    })

    it('refresh token cấp TRƯỚC lần đổi/reset mật khẩu (iat < tokens_valid_after) → 401; cấp sau thì qua', async () => {
      const changedAt = new Date('2026-10-11T10:00:00Z')
      const before = Math.floor(changedAt.getTime() / 1000) - 60
      const after = Math.floor(changedAt.getTime() / 1000) + 60
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, tokens_valid_after: changedAt })
      mockPrisma.revokedSession.findUnique.mockResolvedValue(null)

      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh', iat: before })
      await expect(service.refresh('old')).rejects.toThrow(UnauthorizedException)

      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh', iat: after })
      await expect(service.refresh('new')).resolves.toHaveProperty('access_token')
    })
  })

  describe('refresh', () => {
    it('should return new tokens on valid refresh token', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh' })
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)

      const result = await service.refresh('valid-refresh-token')

      expect(result).toHaveProperty('access_token')
      expect(result).toHaveProperty('refresh_token')
    })

    it('should throw 401 on invalid refresh token', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('invalid token')
      })

      await expect(service.refresh('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      )
    })

    it('should throw 401 when user is blacklisted', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh' })
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      tokenBlacklist.blacklistUser(1)

      await expect(service.refresh('valid-token')).rejects.toThrow(
        UnauthorizedException,
      )
    })

    it('refresh KHÔNG mang sid vẫn qua được (fail-open, tính năng tắt)', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh' })
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)

      await expect(service.refresh('valid-refresh-token')).resolves.toHaveProperty(
        'access_token',
      )
    })

    it('refresh với sid ĐÃ bị thay thế bởi phiên mới → 401', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      activeSession.startSession(1) // phiên MỚI ghi đè "sid-cu"
      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh', sid: 'sid-cu' })

      await expect(service.refresh('valid-refresh-token')).rejects.toThrow(
        UnauthorizedException,
      )
    })

    it('refresh với sid khớp phiên hiện tại vẫn qua được', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      const sid = activeSession.startSession(1)
      mockJwtService.verify.mockReturnValue({ sub: 1, type: 'refresh', sid })

      await expect(service.refresh('valid-refresh-token')).resolves.toHaveProperty(
        'access_token',
      )
    })
  })

  describe('login — single-session', () => {
    beforeEach(() => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
    })

    it('tính năng TẮT (mặc định) → KHÔNG đăng ký phiên mới', async () => {
      await service.login({ email: mockUser.email, password: 'pw' })
      // Chưa có phiên nào được theo dõi ⇒ fail-open cho MỌI sid (kể cả không có)
      expect(activeSession.isCurrentSession(mockUser.id, 'bat-ky-sid-nao')).toBe(true)
    })

    it('tính năng BẬT qua ENV → login đăng ký phiên MỚI, đá phiên cũ', async () => {
      process.env.SINGLE_SESSION_ENABLED = 'true'
      try {
        activeSession.startSession(mockUser.id) // giả lập phiên đang sống từ trước
        const oldSid = 'phien-truoc-do'
        expect(activeSession.isCurrentSession(mockUser.id, oldSid)).toBe(false)

        await service.login({ email: mockUser.email, password: 'pw' })

        // Sau login MỚI, sid CŨ (khác lần startSession vừa rồi) vẫn bị coi là đã thay thế
        expect(activeSession.isCurrentSession(mockUser.id, oldSid)).toBe(false)
      } finally {
        delete process.env.SINGLE_SESSION_ENABLED
      }
    })
  })

  describe('getMe', () => {
    it('trả user + roles[] + permissions + isAdmin (RBAC quyền + phạm vi)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      mockPermissionService.grantsFor.mockResolvedValueOnce({
        grants: { 'contacts.view': 'team' },
        isAdmin: false,
      })

      const result = await service.getMe(1)

      expect(result.user.id).toBe(1)
      expect(result.user.email).toBe(mockUser.email)
      expect(result.roles).toEqual([{ id: undefined, name: 'Nhân viên kinh doanh', is_system: undefined }])
      expect(result.permissions).toEqual({ 'contacts.view': 'team' })
      expect(result.isAdmin).toBe(false)
    })

    it('access token/refresh token KHÔNG chứa role/team_id (chỉ sub, email, sid?)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      await service.login({ email: mockUser.email, password: 'pw' }, '127.0.0.1')

      const [payload] = mockJwtService.sign.mock.calls[0]
      expect(payload).toEqual({ sub: mockUser.id, email: mockUser.email })
      expect(payload).not.toHaveProperty('role')
      expect(payload).not.toHaveProperty('team_id')
    })

    it('should throw 404 when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      await expect(service.getMe(999)).rejects.toThrow(NotFoundException)
    })
  })

  describe('changePassword', () => {
    it('should change password and blacklist user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('new-hash')
      mockPrisma.user.update.mockResolvedValue({})

      const result = await service.changePassword(1, 'old-pass', 'new-pass-123', '10.0.0.5')

      expect(result.message).toBe('Đổi mật khẩu thành công')
      expect(tokenBlacklist.isBlacklisted(1)).toBe(true)
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { password_hash: 'new-hash', password_updated_at: expect.any(Date), tokens_valid_after: expect.any(Date) },
      })
    })

    it('should throw 401 on wrong current password', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(false)

      await expect(
        service.changePassword(1, 'wrong', 'new-pass'),
      ).rejects.toThrow(UnauthorizedException)
    })

    // audit_logs trước đây RỖNG cho MỌI đường đổi mật khẩu — bịt lỗ hổng.
    it('should write password_change audit log (method=self_change)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('new-hash')
      mockPrisma.user.update.mockResolvedValue({})

      await service.changePassword(1, 'old-pass', 'new-pass-123', '10.0.0.5')

      expect(mockAuditLog.logPasswordChange).toHaveBeenCalledWith({
        actorUserId: 1,
        targetUserId: 1,
        method: 'self_change',
        ipAddress: '10.0.0.5',
      })
    })
  })

  describe('resetMyPassword', () => {
    it('should generate new password and blacklist user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('new-hash')
      mockPrisma.user.update.mockResolvedValue({})
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      const result = await service.resetMyPassword(1, 'old-password')

      expect(result.message).toBe('Reset mật khẩu thành công')
      expect(result.newPassword).toBeDefined()
      expect(result.newPassword.length).toBe(12)
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { password_hash: 'new-hash', password_updated_at: expect.any(Date), tokens_valid_after: expect.any(Date) },
      })
      expect(tokenBlacklist.isBlacklisted(1)).toBe(true)
    })

    it('rejects with 401 and does not change password when current password is wrong', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(false)
      mockPrisma.user.update.mockClear()

      await expect(service.resetMyPassword(1, 'wrong')).rejects.toThrow(UnauthorizedException)
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('should throw 404 when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      await expect(service.resetMyPassword(999, 'x')).rejects.toThrow(
        NotFoundException,
      )
    })

    it('should write password_change audit log (method=self_reset)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser)
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('new-hash')
      mockPrisma.user.update.mockResolvedValue({})
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)

      await service.resetMyPassword(1, 'old-password', '10.0.0.5')

      expect(mockAuditLog.logPasswordChange).toHaveBeenCalledWith({
        actorUserId: 1,
        targetUserId: 1,
        method: 'self_reset',
        ipAddress: '10.0.0.5',
      })
    })
  })
})
