import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { ProductCategoriesService } from '../product-categories.service';
import { CreateProductCategoryDto } from '../dto/create-product-category.dto';
import { UpdateProductCategoryDto } from '../dto/update-product-category.dto';

const categoryRow = {
  id: 3,
  code: 'retail',
  name: 'Bán lẻ',
  description: 'Sản phẩm dịch vụ',
  is_active: true,
  sort_order: 0,
  created_by: 1,
  created_at: new Date('2026-09-24'),
  updated_at: new Date('2026-09-24'),
};

const mockPrisma = {
  productCategory: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

const baseDto = (): CreateProductCategoryDto =>
  ({ code: 'retail', name: 'Bán lẻ' }) as CreateProductCategoryDto;

describe('ProductCategoriesService', () => {
  let service: ProductCategoriesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductCategoriesService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(ProductCategoriesService);
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('mặc định CHỈ lấy is_active=true', async () => {
      mockPrisma.productCategory.findMany.mockResolvedValue([categoryRow]);

      await service.findAll(false);

      expect(mockPrisma.productCategory.findMany.mock.calls[0][0].where).toEqual({
        is_active: true,
      });
    });

    it('include_inactive=true → bỏ filter is_active', async () => {
      mockPrisma.productCategory.findMany.mockResolvedValue([categoryRow]);

      await service.findAll(true);

      expect(mockPrisma.productCategory.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('sort sort_order ASC rồi id ASC — KHÔNG take (bảng nhỏ)', async () => {
      mockPrisma.productCategory.findMany.mockResolvedValue([]);
      await service.findAll(false);
      const args = mockPrisma.productCategory.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ sort_order: 'asc' }, { id: 'asc' }]);
      expect(args).not.toHaveProperty('take');
    });
  });

  describe('findOne', () => {
    it('không tồn tại → 404', async () => {
      mockPrisma.productCategory.findUnique.mockResolvedValue(null);
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('tạo được danh mục', async () => {
      mockPrisma.productCategory.findFirst.mockResolvedValue(null);
      mockPrisma.productCategory.create.mockResolvedValue(categoryRow);

      const result = await service.create(baseDto(), 1);

      expect(result.code).toBe('retail');
      expect(mockPrisma.productCategory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'retail', name: 'Bán lẻ', created_by: 1 }),
        }),
      );
    });

    it('code trùng (kể cả khác hoa/thường) → 409, KHÔNG ghi gì', async () => {
      mockPrisma.productCategory.findFirst.mockResolvedValue({ id: 5, code: 'retail' });

      await expect(service.create({ ...baseDto(), code: 'RETAIL' }, 1)).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrisma.productCategory.create).not.toHaveBeenCalled();
    });

    it('race P2002 → 409, không rơi 500', async () => {
      mockPrisma.productCategory.findFirst.mockResolvedValue(null);
      mockPrisma.productCategory.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { target: ['code'] },
        }),
      );
      await expect(service.create(baseDto(), 1)).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('chỉ ghi field CÓ GỬI', async () => {
      mockPrisma.productCategory.findUnique.mockResolvedValue(categoryRow);
      mockPrisma.productCategory.update.mockResolvedValue(categoryRow);

      await service.update(3, { name: 'Bán lẻ cao cấp' } as UpdateProductCategoryDto);

      expect(mockPrisma.productCategory.update.mock.calls[0][0].data).toEqual({
        name: 'Bán lẻ cao cấp',
      });
    });

    it('is_active=false ẨN khỏi dropdown (không xoá)', async () => {
      mockPrisma.productCategory.findUnique.mockResolvedValue(categoryRow);
      mockPrisma.productCategory.update.mockResolvedValue({ ...categoryRow, is_active: false });

      const result = await service.update(3, { is_active: false });

      expect(mockPrisma.productCategory.update.mock.calls[0][0].data).toEqual({
        is_active: false,
      });
      expect(result.is_active).toBe(false);
    });

    it('không tồn tại → 404, KHÔNG update', async () => {
      mockPrisma.productCategory.findUnique.mockResolvedValue(null);
      await expect(service.update(999, { name: 'x' })).rejects.toThrow(NotFoundException);
      expect(mockPrisma.productCategory.update).not.toHaveBeenCalled();
    });
  });

  describe('assertCategoryExists', () => {
    it('không tồn tại → 400 (dùng bởi ProductAttributeDefsService)', async () => {
      mockPrisma.productCategory.findUnique.mockResolvedValue(null);
      await expect(service.assertCategoryExists(999)).rejects.toThrow(BadRequestException);
    });

    it('tồn tại (kể cả is_active=false) → qua — assertCategoryExists KHÔNG đòi active', async () => {
      mockPrisma.productCategory.findUnique.mockResolvedValue({ id: 3 });
      await expect(service.assertCategoryExists(3)).resolves.toBeUndefined();
    });
  });
});
