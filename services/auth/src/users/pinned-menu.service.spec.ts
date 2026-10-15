import { Test, TestingModule } from '@nestjs/testing'
import { PinnedMenuService } from './pinned-menu.service'
import { PrismaService } from '@trinity/prisma'

interface MockPrisma {
  user: { findUnique: jest.Mock; update: jest.Mock }
}

const mockPrisma: MockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
}

describe('PinnedMenuService', () => {
  let service: PinnedMenuService

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PinnedMenuService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile()
    service = module.get<PinnedMenuService>(PinnedMenuService)
  })

  describe('get', () => {
    it('trả mảng đã lưu khi user đã tuỳ chỉnh', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ pinned_menu_keys: ['contacts', 'kanban'] })
      const result = await service.get(1)
      expect(result).toEqual({ keys: ['contacts', 'kanban'] })
    })

    it('trả [] khi user chưa từng tuỳ chỉnh (chưa có row / cột rỗng)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ pinned_menu_keys: [] })
      const result = await service.get(1)
      expect(result).toEqual({ keys: [] })
    })

    it('trả [] khi KHÔNG tìm thấy user (an toàn, không throw)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)
      const result = await service.get(999)
      expect(result).toEqual({ keys: [] })
    })
  })

  describe('update', () => {
    it('dedupe trước khi ghi DB', async () => {
      mockPrisma.user.update.mockResolvedValue({ pinned_menu_keys: ['contacts', 'kanban'] })
      await service.update(1, ['contacts', 'contacts', 'kanban'])
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { pinned_menu_keys: ['contacts', 'kanban'] },
        select: { pinned_menu_keys: true },
      })
    })

    it('ghi được mảng rỗng (user chủ động bỏ ghim hết)', async () => {
      mockPrisma.user.update.mockResolvedValue({ pinned_menu_keys: [] })
      const result = await service.update(1, [])
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { pinned_menu_keys: [] },
        select: { pinned_menu_keys: true },
      })
      expect(result).toEqual({ keys: [] })
    })
  })
})
