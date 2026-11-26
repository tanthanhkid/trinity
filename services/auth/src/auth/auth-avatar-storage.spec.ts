import { Test } from '@nestjs/testing'
import { JwtService } from '@nestjs/jwt'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { PrismaService } from '@trinity/prisma'
import { PermissionService } from '@trinity/rbac-nest'
import { AuthService } from './auth.service'
import { RateLimiterService } from './services/rate-limiter.service'
import { TokenBlacklistService, ActiveSessionService } from '@trinity/rbac-nest'
import { AuditLogService } from './services/audit-log.service'

// ảnh đại diện đi qua kho uploads trên đĩa.
describe('AuthService.uploadAvatar — kho uploads', () => {
  const OLD = { ...process.env }
  const prisma = { user: { findUnique: jest.fn(), update: jest.fn() } }
  let service: AuthService
  let png: Buffer

  beforeAll(async () => {
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).png().toBuffer()
  })

  beforeEach(async () => {
    jest.clearAllMocks()
    const mod = await Test.createTestingModule({
      providers: [
        AuthService,
        RateLimiterService,
        TokenBlacklistService,
        ActiveSessionService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: PermissionService, useValue: {} },
      ],
    }).compile()
    service = mod.get(AuthService)
  })

  afterEach(() => {
    process.env = { ...OLD }
    jest.restoreAllMocks()
  })

  const file = () =>
    ({ buffer: png, size: png.length, mimetype: 'image/png' }) as Express.Multer.File

  it('mặc định: ghi JPEG vào <UPLOADS_LOCAL_ROOT>/avatars và xoá ảnh cũ', async () => {
    const root = mkdtempSync(join(tmpdir(), 'avatar-'))
    try {
      delete process.env.STORAGE_DRIVER
      process.env.UPLOADS_LOCAL_ROOT = root
      mkdirSync(join(root, 'avatars'))
      writeFileSync(join(root, 'avatars', 'old.jpg'), 'x')
      prisma.user.findUnique.mockResolvedValue({ id: 5, avatar_url: '/uploads/avatars/old.jpg' })
      const r = await service.uploadAvatar(5, file())
      expect(r.avatar_url).toMatch(/^\/uploads\/avatars\/5_\d+\.jpg$/)
      expect(existsSync(join(root, r.avatar_url.replace('/uploads/', '')))).toBe(true)
      expect(existsSync(join(root, 'avatars', 'old.jpg'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
