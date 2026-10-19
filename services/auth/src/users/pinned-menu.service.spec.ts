import { Test, TestingModule } from '@nestjs/testing'
import { PinnedMenuService } from './pinned-menu.service'
import { PrismaService } from '@trinity/prisma'

interface MockPrisma {
  user: { findUnique: jest.Mock; update: jest.Mock }
  customObject: { findMany: jest.Mock }
  customView: { findMany: jest.Mock }
}

const mockPrisma: MockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  customObject: { findMany: jest.fn() },
  customView: { findMany: jest.fn() },
}

describe('PinnedMenuService', () => {
  let service: PinnedMenuService

  beforeEach(async () => {
    jest.clearAllMocks()
    mockPrisma.customObject.findMany.mockResolvedValue([])
    mockPrisma.customView.findMany.mockResolvedValue([])
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

    it('ghim bảng tuỳ biến tồn tại: giữ key custom_<key>', async () => {
      mockPrisma.customObject.findMany.mockResolvedValue([{ id: 7, key: 'ghi_danh' }])
      mockPrisma.user.update.mockResolvedValue({ pinned_menu_keys: ['contacts', 'custom_ghi_danh'] })
      await service.update(1, ['contacts', 'custom_ghi_danh'])
      expect(mockPrisma.customObject.findMany).toHaveBeenCalledWith({
        where: { key: { in: ['ghi_danh'] }, deleted_at: null, is_active: true },
        select: { id: true, key: true },
      })
      expect(mockPrisma.user.update.mock.calls[0][0].data).toEqual({ pinned_menu_keys: ['contacts', 'custom_ghi_danh'] })
    })

    it('ghim màn xem của bảng tuỳ biến: kiểm cả màn', async () => {
      mockPrisma.customObject.findMany.mockResolvedValue([{ id: 7, key: 'hoc_sinh' }])
      mockPrisma.customView.findMany.mockResolvedValue([{ object_id: 7, key: 'lop_a' }])
      mockPrisma.user.update.mockResolvedValue({ pinned_menu_keys: [] })
      await service.update(1, ['custom_hoc_sinh__lop_a', 'custom_hoc_sinh__da_xoa'])
      expect(mockPrisma.user.update.mock.calls[0][0].data).toEqual({ pinned_menu_keys: ['custom_hoc_sinh__lop_a'] })
    })

    it('key bảng có chứa "__": hiểu là bảng, không nhầm với bảng + màn', async () => {
      mockPrisma.customObject.findMany.mockResolvedValue([{ id: 3, key: 'a__b' }])
      mockPrisma.user.update.mockResolvedValue({ pinned_menu_keys: [] })
      await service.update(1, ['custom_a__b'])
      expect(mockPrisma.user.update.mock.calls[0][0].data).toEqual({ pinned_menu_keys: ['custom_a__b'] })
    })

    it('bảng đã xoá/lưu trữ/không tồn tại: bỏ key, không lỗi, giữ key cố định', async () => {
      mockPrisma.customObject.findMany.mockResolvedValue([])
      mockPrisma.user.update.mockResolvedValue({ pinned_menu_keys: ['kanban'] })
      await service.update(1, ['kanban', 'custom_da_xoa'])
      expect(mockPrisma.user.update.mock.calls[0][0].data).toEqual({ pinned_menu_keys: ['kanban'] })
    })

    it('chỉ key cố định: không truy vấn bảng tuỳ biến', async () => {
      mockPrisma.user.update.mockResolvedValue({ pinned_menu_keys: ['kanban'] })
      await service.update(1, ['kanban'])
      expect(mockPrisma.customObject.findMany).not.toHaveBeenCalled()
    })
  })

  describe('get — lọc ghim bảng tuỳ biến đã mất', () => {
    it('không trả key của bảng đã xoá', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ pinned_menu_keys: ['contacts', 'custom_da_xoa', 'custom_con'] })
      mockPrisma.customObject.findMany.mockResolvedValue([{ id: 1, key: 'con' }])
      expect(await service.get(1)).toEqual({ keys: ['contacts', 'custom_con'] })
    })
  })
})
