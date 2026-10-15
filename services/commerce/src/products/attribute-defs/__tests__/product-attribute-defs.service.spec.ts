import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { ProductAttributeDefsService } from '../product-attribute-defs.service';
import { ProductCategoriesService } from '../../categories/product-categories.service';
import { CreateAttributeDefDto } from '../dto/create-attribute-def.dto';
import { UpdateAttributeDefDto } from '../dto/update-attribute-def.dto';

const defRow = {
  id: 10,
  category_id: 3,
  key: 'material',
  label: 'Chất liệu',
  type: 'text',
  options: null,
  is_required: true,
  sort_order: 0,
  created_at: new Date('2026-09-24'),
  updated_at: new Date('2026-09-24'),
};

const mockPrisma = {
  productAttributeDef: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

const mockCategoriesService = {
  assertCategoryExists: jest.fn(),
};

const baseDto = (): CreateAttributeDefDto =>
  ({ key: 'material', label: 'Chất liệu', type: 'text' }) as CreateAttributeDefDto;

describe('ProductAttributeDefsService', () => {
  let service: ProductAttributeDefsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductAttributeDefsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ProductCategoriesService, useValue: mockCategoriesService },
      ],
    }).compile();
    service = module.get(ProductAttributeDefsService);
    jest.clearAllMocks();
  });

  describe('findAllForCategory / findAllForCategoryAsValidatorDefs', () => {
    it('sort sort_order ASC rồi id ASC', async () => {
      mockPrisma.productAttributeDef.findMany.mockResolvedValue([defRow]);
      await service.findAllForCategory(3);
      const args = mockPrisma.productAttributeDef.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ category_id: 3 });
      expect(args.orderBy).toEqual([{ sort_order: 'asc' }, { id: 'asc' }]);
    });

    it('rút gọn đúng shape AttributeDefLike cho validator', async () => {
      mockPrisma.productAttributeDef.findMany.mockResolvedValue([defRow]);
      const result = await service.findAllForCategoryAsValidatorDefs(3);
      expect(result).toEqual([
        {
          key: 'material',
          label: 'Chất liệu',
          type: 'text',
          options: null,
          is_required: true,
        },
      ]);
    });
  });

  describe('create', () => {
    it('category KHÔNG tồn tại → assertCategoryExists ném, KHÔNG ghi gì', async () => {
      mockCategoriesService.assertCategoryExists.mockRejectedValue(
        new BadRequestException('Danh mục sản phẩm ID 999 không tồn tại'),
      );

      await expect(service.create(999, baseDto())).rejects.toThrow(BadRequestException);
      expect(mockPrisma.productAttributeDef.create).not.toHaveBeenCalled();
    });

    it('tạo được def khi category hợp lệ', async () => {
      mockCategoriesService.assertCategoryExists.mockResolvedValue(undefined);
      mockPrisma.productAttributeDef.findFirst.mockResolvedValue(null);
      mockPrisma.productAttributeDef.create.mockResolvedValue(defRow);

      const result = await service.create(3, baseDto());

      expect(result.key).toBe('material');
      expect(mockPrisma.productAttributeDef.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            category_id: 3,
            key: 'material',
            is_required: false,
            sort_order: 0,
          }),
        }),
      );
    });

    it('key trùng trong CÙNG danh mục → 409, KHÔNG ghi gì', async () => {
      mockCategoriesService.assertCategoryExists.mockResolvedValue(undefined);
      mockPrisma.productAttributeDef.findFirst.mockResolvedValue({ id: 1 });

      await expect(service.create(3, baseDto())).rejects.toThrow(ConflictException);
      expect(mockPrisma.productAttributeDef.create).not.toHaveBeenCalled();
    });

    it('race P2002 (unique category_id+key) → 409, không rơi 500', async () => {
      mockCategoriesService.assertCategoryExists.mockResolvedValue(undefined);
      mockPrisma.productAttributeDef.findFirst.mockResolvedValue(null);
      mockPrisma.productAttributeDef.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { target: ['category_id', 'key'] },
        }),
      );

      await expect(service.create(3, baseDto())).rejects.toThrow(ConflictException);
    });
  });

  describe('select/multiselect cần options', () => {
    it('create type=select không options → 400, không ghi', async () => {
      mockPrisma.productAttributeDef.findFirst.mockResolvedValue(null);
      await expect(
        service.create(3, { ...baseDto(), type: 'select' } as CreateAttributeDefDto),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.productAttributeDef.create).not.toHaveBeenCalled();
    });

    it('update đổi type sang multiselect khi def chưa có options → 400', async () => {
      mockPrisma.productAttributeDef.findUnique.mockResolvedValue({ id: 10, type: 'text', options: null });
      await expect(
        service.update(10, { type: 'multiselect' } as UpdateAttributeDefDto),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.productAttributeDef.update).not.toHaveBeenCalled();
    });

    it('update xoá options của def đang là select → 400', async () => {
      mockPrisma.productAttributeDef.findUnique.mockResolvedValue({
        id: 10, type: 'select', options: [{ value: 'a', label: 'A' }],
      });
      await expect(
        service.update(10, { options: null } as unknown as UpdateAttributeDefDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('chỉ ghi field CÓ GỬI, `key` KHÔNG có trong DTO nên không thể ghi', async () => {
      mockPrisma.productAttributeDef.findUnique.mockResolvedValue({ id: 10 });
      mockPrisma.productAttributeDef.update.mockResolvedValue(defRow);

      await service.update(10, { label: 'Tỷ lệ' } as UpdateAttributeDefDto);

      const data = mockPrisma.productAttributeDef.update.mock.calls[0][0].data;
      expect(data).toEqual({ label: 'Tỷ lệ' });
      expect(data).not.toHaveProperty('key');
    });

    it('options=null xoá lựa chọn (đổi type rời khỏi select/multiselect)', async () => {
      mockPrisma.productAttributeDef.findUnique.mockResolvedValue({ id: 10 });
      mockPrisma.productAttributeDef.update.mockResolvedValue({ ...defRow, options: null });

      await service.update(10, { options: null } as unknown as UpdateAttributeDefDto);

      expect(mockPrisma.productAttributeDef.update.mock.calls[0][0].data.options).toBe(
        Prisma.JsonNull,
      );
    });

    it('không tồn tại → 404, KHÔNG update', async () => {
      mockPrisma.productAttributeDef.findUnique.mockResolvedValue(null);
      await expect(service.update(999, { label: 'x' })).rejects.toThrow(NotFoundException);
      expect(mockPrisma.productAttributeDef.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('hard delete — bảng cấu hình, không phải dữ liệu khách', async () => {
      mockPrisma.productAttributeDef.findUnique.mockResolvedValue({ id: 10 });
      mockPrisma.productAttributeDef.delete.mockResolvedValue(defRow);

      await service.remove(10);

      expect(mockPrisma.productAttributeDef.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    });

    it('không tồn tại → 404', async () => {
      mockPrisma.productAttributeDef.findUnique.mockResolvedValue(null);
      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.productAttributeDef.delete).not.toHaveBeenCalled();
    });
  });
});
