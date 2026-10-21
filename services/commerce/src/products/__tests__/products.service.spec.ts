import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';

/** Quản trị — được xoá hẳn / khôi phục mọi sản phẩm. */
const admin = { userId: 1, isAdmin: true, grants: {} } as never;
import { Prisma, PrismaService } from '@trinity/prisma';
import { ProductsService } from '../products.service';
import { ProductAttributeDefsService } from '../attribute-defs/product-attribute-defs.service';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';

const productRow = {
  id: 1,
  code: 'SP-500',
  name: 'Gói dịch vụ cơ bản',
  project_id: 7 as number | null,
  brand: 'Acme',
  color: '#00753c',
  tags: ['Phổ biến', 'Mới'],
  is_featured: true,
  image_url: null as string | null,
  category_id: null as number | null,
  attributes: {} as Prisma.JsonValue,
  description: null as string | null,
  price: null as bigint | null,
  is_active: true,
  created_by: 1,
  created_at: new Date('2026-09-09'),
  updated_at: new Date('2026-09-09'),
};

const mockPrisma = {
  product: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    // `assertCodeAvailable` dùng findFirst (so `code` insensitive) — tách khỏi findUnique(id).
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn(),
  project: {
    findUnique: jest.fn(),
  },
  productCategory: {
    findUnique: jest.fn(),
  },
};

const mockTx = {
  $queryRaw: jest.fn(),
  contact: { count: jest.fn() },
  product: { findUnique: jest.fn(), delete: jest.fn() },
};
const deleteImage = jest.fn();
jest.mock('../product-image-upload.helper', () => ({
  ...jest.requireActual('../product-image-upload.helper'),
  deleteProductImageFile: (...a: unknown[]) => deleteImage(...a),
}));

const mockAttributeDefsService = {
  findAllForCategoryAsValidatorDefs: jest.fn(),
};

const activeProject = { id: 7, name: 'Dự án Acme', is_active: true };
const activeCategory = { id: 3, name: 'Bán lẻ', is_active: true };

const baseDto = (): CreateProductDto =>
  ({
    code: 'SP-500',
    name: 'Gói dịch vụ cơ bản',
    project_id: 7,
  }) as CreateProductDto;

describe('ProductsService (khung sản phẩm đa ngành)', () => {
  let service: ProductsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ProductAttributeDefsService, useValue: mockAttributeDefsService },
      ],
    }).compile();
    service = module.get(ProductsService);
    jest.clearAllMocks();
    mockTx.$queryRaw.mockReset();
    mockPrisma.$transaction.mockImplementation((fn: (t: typeof mockTx) => unknown) => fn(mockTx));
    mockAttributeDefsService.findAllForCategoryAsValidatorDefs.mockResolvedValue([]);
  });

  describe('create', () => {
    it('tạo được sản phẩm; BigInt (price) → number khi trả FE', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(activeProject);
      mockPrisma.product.findFirst.mockResolvedValue(null);
      mockPrisma.product.create.mockResolvedValue({
        ...productRow,
        price: BigInt(500000),
      });

      const result = await service.create({ ...baseDto(), price: 500000 }, 99);

      expect(result.price).toBe(500000);
      // Không được để BigInt lọt ra response — JSON.stringify(BigInt) ném TypeError.
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(mockPrisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'SP-500', project_id: 7, created_by: 99 }),
        }),
      );
    });

    it('project_id KHÔNG gửi → KHÔNG kiểm dự án, tạo được sản phẩm không-thuộc-dự-án', async () => {
      mockPrisma.product.findFirst.mockResolvedValue(null);
      mockPrisma.product.create.mockResolvedValue({ ...productRow, project_id: null });

      const result = await service.create({ code: 'RETAIL-001', name: 'Áo thun' } as CreateProductDto, 1);

      expect(mockPrisma.project.findUnique).not.toHaveBeenCalled();
      expect(result.project_id).toBeNull();
    });

    it('code TRÙNG → 409 ConflictException, KHÔNG ghi gì', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(activeProject);
      mockPrisma.product.findFirst.mockResolvedValue({ id: 5, code: 'SP-500' });

      await expect(service.create(baseDto(), 1)).rejects.toThrow(ConflictException);
      expect(mockPrisma.product.create).not.toHaveBeenCalled();
    });

    it('code trùng KHÁC hoa/thường (`sp-500x` vs `SP-500`) → 409, so insensitive', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(activeProject);
      mockPrisma.product.findFirst.mockResolvedValue({ id: 5, code: 'SP-500' });

      await expect(service.create({ ...baseDto(), code: 'sp-500x' }, 1)).rejects.toThrow(
        /không phân biệt hoa\/thường/,
      );
      expect(mockPrisma.product.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { code: { equals: 'sp-500x', mode: 'insensitive' } },
        }),
      );
      expect(mockPrisma.product.create).not.toHaveBeenCalled();
    });

    it('race cùng code (P2002 từ unique index) → 409, KHÔNG rơi ra 500', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(activeProject);
      mockPrisma.product.findFirst.mockResolvedValue(null);
      mockPrisma.product.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { target: ['code'] },
        }),
      );

      await expect(service.create(baseDto(), 1)).rejects.toThrow(ConflictException);
    });

    it('P2002 của constraint KHÁC → rethrow nguyên vẹn (không che lỗi data thật)', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(activeProject);
      mockPrisma.product.findFirst.mockResolvedValue(null);
      const other = new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['some_other_column'] },
      });
      mockPrisma.product.create.mockRejectedValue(other);

      await expect(service.create(baseDto(), 1)).rejects.toBe(other);
    });

    it('project_id KHÔNG tồn tại → 400, kiểm dự án TRƯỚC khi kiểm code', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(null);

      await expect(service.create(baseDto(), 1)).rejects.toThrow(BadRequestException);
      expect(mockPrisma.product.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.product.create).not.toHaveBeenCalled();
    });

    it('project đã ngưng hoạt động (is_active=false) → 400', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({ ...activeProject, is_active: false });

      await expect(service.create(baseDto(), 1)).rejects.toThrow(/đã ngưng hoạt động/);
      expect(mockPrisma.product.create).not.toHaveBeenCalled();
    });

    it('KHÔNG gửi price → field vắng khỏi data (giữ NULL "chưa nhập")', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(activeProject);
      mockPrisma.product.findFirst.mockResolvedValue(null);
      mockPrisma.product.create.mockResolvedValue({ ...productRow, price: null });

      const result = await service.create(baseDto(), 1);

      expect(mockPrisma.product.create.mock.calls[0][0].data).not.toHaveProperty('price');
      expect(result.price).toBeNull();
    });

    describe('category_id + attributes', () => {
      it('category_id KHÔNG tồn tại → 400, KHÔNG ghi gì', async () => {
        mockPrisma.project.findUnique.mockResolvedValue(activeProject);
        mockPrisma.productCategory.findUnique.mockResolvedValue(null);

        await expect(service.create({ ...baseDto(), category_id: 999 }, 1)).rejects.toThrow(
          BadRequestException,
        );
        expect(mockPrisma.product.create).not.toHaveBeenCalled();
      });

      it('category đã ngưng hoạt động → 400', async () => {
        mockPrisma.project.findUnique.mockResolvedValue(activeProject);
        mockPrisma.productCategory.findUnique.mockResolvedValue({ ...activeCategory, is_active: false });

        await expect(service.create({ ...baseDto(), category_id: 3 }, 1)).rejects.toThrow(
          /đã ngưng hoạt động/,
        );
      });

      it('attributes hợp lệ theo defs của category → ghi vào cột attributes', async () => {
        mockPrisma.project.findUnique.mockResolvedValue(activeProject);
        mockPrisma.productCategory.findUnique.mockResolvedValue(activeCategory);
        mockAttributeDefsService.findAllForCategoryAsValidatorDefs.mockResolvedValue([
          { key: 'material', label: 'Chất liệu', type: 'text', options: null, is_required: true },
        ]);
        mockPrisma.product.findFirst.mockResolvedValue(null);
        mockPrisma.product.create.mockResolvedValue({
          ...productRow,
          category_id: 3,
          attributes: { material: 'Cotton' },
        });

        const result = await service.create(
          { ...baseDto(), category_id: 3, attributes: { material: 'Cotton' } },
          1,
        );

        expect(mockPrisma.product.create.mock.calls[0][0].data.attributes).toEqual({
          material: 'Cotton',
        });
        expect(result.attributes).toEqual({ material: 'Cotton' });
      });

      it('attributes THIẾU field bắt buộc → 400, KHÔNG ghi gì (validator ném trước khi tới Prisma)', async () => {
        mockPrisma.project.findUnique.mockResolvedValue(activeProject);
        mockPrisma.productCategory.findUnique.mockResolvedValue(activeCategory);
        mockAttributeDefsService.findAllForCategoryAsValidatorDefs.mockResolvedValue([
          { key: 'material', label: 'Chất liệu', type: 'text', options: null, is_required: true },
        ]);

        await expect(service.create({ ...baseDto(), category_id: 3 }, 1)).rejects.toThrow(
          BadRequestException,
        );
        expect(mockPrisma.product.create).not.toHaveBeenCalled();
      });

      it('category_id=null (mặc định) + KHÔNG gửi attributes → ghi {} rỗng, KHÔNG gọi attributeDefsService', async () => {
        mockPrisma.project.findUnique.mockResolvedValue(activeProject);
        mockPrisma.product.findFirst.mockResolvedValue(null);
        mockPrisma.product.create.mockResolvedValue(productRow);

        await service.create(baseDto(), 1);

        expect(mockAttributeDefsService.findAllForCategoryAsValidatorDefs).not.toHaveBeenCalled();
        expect(mockPrisma.product.create.mock.calls[0][0].data.attributes).toEqual({});
      });
    });
  });

  describe('findAll', () => {
    it('sort is_featured DESC rồi id ASC; KHÔNG có take (không cap ⇒ không cắt im lặng)', async () => {
      mockPrisma.product.findMany.mockResolvedValue([productRow]);

      await service.findAll({});

      const args = mockPrisma.product.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ is_featured: 'desc' }, { id: 'asc' }]);
      expect(args).not.toHaveProperty('take');
      expect(args).not.toHaveProperty('skip');
      // Mặc định chỉ sản phẩm chưa xoá (lưu trữ).
      expect(args.where).toEqual({ AND: [{ deleted_at: null }] });
      // `select` tường minh, KHÔNG include/SELECT *.
      expect(args.select).toBeDefined();
    });

    it('is_active=false là bộ lọc HỢP LỆ (không bị truthy-check nuốt)', async () => {
      mockPrisma.product.findMany.mockResolvedValue([]);

      await service.findAll({ is_active: false });

      expect(mockPrisma.product.findMany.mock.calls[0][0].where).toEqual({
        AND: [{ deleted_at: null }, { is_active: false }],
      });
    });

    it('archived=true ⇒ CHỈ sản phẩm đã xoá (lưu trữ), cho Quản trị xoá hẳn', async () => {
      mockPrisma.product.findMany.mockResolvedValue([]);
      await service.findAll({ archived: true });
      expect(mockPrisma.product.findMany.mock.calls[0][0].where).toEqual({ AND: [{ deleted_at: { not: null } }] });
    });

    it('category_id lọc được, ghép AND không spread', async () => {
      mockPrisma.product.findMany.mockResolvedValue([]);

      await service.findAll({ project_id: 7, category_id: 3, q: 'acme' });

      expect(mockPrisma.product.findMany.mock.calls[0][0].where).toEqual({
        AND: [
          { deleted_at: null },
          { project_id: 7 },
          { category_id: 3 },
          {
            OR: [
              { name: { contains: 'acme', mode: 'insensitive' } },
              { code: { contains: 'acme', mode: 'insensitive' } },
              { brand: { contains: 'acme', mode: 'insensitive' } },
            ],
          },
        ],
      });
    });
  });

  describe('findOne', () => {
    it('không tồn tại → 404', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(null);
      await expect(service.findOne(123)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('chỉ ghi field CÓ GỬI — field không gửi vắng hẳn khỏi data', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(productRow);
      mockPrisma.product.update.mockResolvedValue(productRow);

      await service.update(1, { name: 'Tên mới' } as UpdateProductDto);

      const data = mockPrisma.product.update.mock.calls[0][0].data;
      expect(data).toEqual({ name: 'Tên mới' });
      expect(data).not.toHaveProperty('brand');
      expect(data).not.toHaveProperty('tags');
      expect(mockAttributeDefsService.findAllForCategoryAsValidatorDefs).not.toHaveBeenCalled();
    });

    it('KHÔNG BAO GIỜ ghi `code` / `project_id` dù client cố nhét vào body', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(productRow);
      mockPrisma.product.update.mockResolvedValue(productRow);

      await service.update(1, {
        name: 'Tên mới',
        code: 'HACK-1',
        project_id: 999,
      } as unknown as UpdateProductDto);

      const data = mockPrisma.product.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('code');
      expect(data).not.toHaveProperty('project_id');
    });

    it('price=null → ghi NULL thật (xoá giá trị), KHÔNG ném BigInt error', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(productRow);
      mockPrisma.product.update.mockResolvedValue({ ...productRow, price: null });

      const result = await service.update(1, { price: null });

      expect(mockPrisma.product.update.mock.calls[0][0].data).toEqual({ price: null });
      expect(result.price).toBeNull();
    });

    it('mảng `tags` ghi bằng { set } để REPLACE, không append', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(productRow);
      mockPrisma.product.update.mockResolvedValue(productRow);

      await service.update(1, { tags: ['A'] });

      expect(mockPrisma.product.update.mock.calls[0][0].data).toEqual({
        tags: { set: ['A'] },
      });
    });

    it('không tồn tại → 404, KHÔNG update', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(null);

      await expect(service.update(1, { name: 'x' })).rejects.toThrow(NotFoundException);
      expect(mockPrisma.product.update).not.toHaveBeenCalled();
    });

    describe('category_id + attributes', () => {
      it('đổi category_id → validate lại attributes theo defs của category MỚI', async () => {
        mockPrisma.product.findUnique.mockResolvedValue({ ...productRow, category_id: null, attributes: {} });
        mockPrisma.productCategory.findUnique.mockResolvedValue(activeCategory);
        mockAttributeDefsService.findAllForCategoryAsValidatorDefs.mockResolvedValue([
          { key: 'warranty_months', label: 'Bảo hành (tháng)', type: 'number', options: null, is_required: false },
        ]);
        mockPrisma.product.update.mockResolvedValue({ ...productRow, category_id: 3 });

        await service.update(1, { category_id: 3, attributes: { warranty_months: 12 } });

        expect(mockPrisma.product.update.mock.calls[0][0].data).toMatchObject({
          category_id: 3,
          attributes: { warranty_months: 12 },
        });
      });

      it('CHỈ gửi attributes (category_id giữ nguyên) → validate theo defs của category HIỆN TẠI', async () => {
        mockPrisma.product.findUnique.mockResolvedValue({
          ...productRow,
          category_id: 3,
          attributes: { warranty_months: 6 },
        });
        mockAttributeDefsService.findAllForCategoryAsValidatorDefs.mockResolvedValue([
          { key: 'warranty_months', label: 'Bảo hành (tháng)', type: 'number', options: null, is_required: false },
        ]);
        mockPrisma.product.update.mockResolvedValue(productRow);

        await service.update(1, { attributes: { warranty_months: 24 } });

        expect(mockAttributeDefsService.findAllForCategoryAsValidatorDefs).toHaveBeenCalledWith(3);
        expect(mockPrisma.product.update.mock.calls[0][0].data.attributes).toEqual({
          warranty_months: 24,
        });
      });

      it('xoá category_id (về null) mà attributes hiện có KHÔNG rỗng → 400 (fail-loud, KHÔNG mồ côi dữ liệu)', async () => {
        mockPrisma.product.findUnique.mockResolvedValue({
          ...productRow,
          category_id: 3,
          attributes: { warranty_months: 6 },
        });

        await expect(service.update(1, { category_id: null })).rejects.toThrow(BadRequestException);
        expect(mockPrisma.product.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('hide', () => {
    it('ẨN: chỉ set is_active=false, KHÔNG xoá', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(productRow);
      mockPrisma.product.update.mockResolvedValue({ ...productRow, is_active: false });
      const result = await service.hide(1);
      expect(mockPrisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1 }, data: { is_active: false } }),
      );
      expect(result.is_active).toBe(false);
      expect(mockTx.product.delete).not.toHaveBeenCalled();
    });
  });

  describe('purge — xoá cứng (chỉ Quản trị)', () => {
    const setup = (o: { exists?: boolean; orders?: number; contacts?: number; image?: string | null } = {}) => {
      mockTx.$queryRaw
        .mockResolvedValueOnce(o.exists === false ? [] : [{ id: 1 }]) // FOR UPDATE
        .mockResolvedValueOnce([{ n: o.orders ?? 0 }]); // đếm đơn
      mockTx.contact.count.mockResolvedValue(o.contacts ?? 0);
      mockTx.product.findUnique.mockResolvedValue({ image_url: o.image ?? null });
      mockTx.product.delete.mockResolvedValue({});
    };

    it('không tham chiếu → xoá hẳn trong transaction + khoá hàng FOR UPDATE', async () => {
      setup();
      await expect(service.purge(1, admin)).resolves.toEqual({ id: 1, deleted: true });
      expect(mockTx.product.delete).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(String(mockTx.$queryRaw.mock.calls[0][0].join(' '))).toContain('FOR UPDATE');
    });

    it('đã có trong đơn POS → 409 nguyên văn tiếng Việt, KHÔNG xoá', async () => {
      setup({ orders: 3 });
      await expect(service.purge(1, admin)).rejects.toThrow(
        new ConflictException('Sản phẩm đã có trong 3 đơn bán hàng — không thể xoá hẳn, chỉ có thể ẩn'),
      );
      expect(mockTx.product.delete).not.toHaveBeenCalled();
    });

    it('đang gắn cho liên hệ → 409 nêu cả đơn lẫn liên hệ', async () => {
      setup({ orders: 2, contacts: 5 });
      await expect(service.purge(1, admin)).rejects.toThrow('2 đơn bán hàng và 5 liên hệ');
      expect(mockTx.product.delete).not.toHaveBeenCalled();
    });

    it('không tồn tại → 404, không đếm/xoá', async () => {
      setup({ exists: false });
      await expect(service.purge(1, admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockTx.product.delete).not.toHaveBeenCalled();
      expect(mockTx.contact.count).not.toHaveBeenCalled();
    });

    it('ảnh /uploads/products/... không ai dùng nữa → dọn file sau commit; còn dùng chung → giữ', async () => {
      setup({ image: '/uploads/products/a_b.png' });
      mockPrisma.product.count.mockResolvedValue(1);
      await service.purge(1, admin);
      expect(deleteImage).not.toHaveBeenCalled();

      setup({ image: '/uploads/products/a_b.png' });
      mockPrisma.product.count.mockResolvedValue(0);
      await service.purge(1, admin);
      expect(deleteImage).toHaveBeenCalledWith('/uploads/products/a_b.png');
    });

    it('lỗi 409 thì KHÔNG đụng file ảnh', async () => {
      setup({ orders: 1, image: '/uploads/products/a_b.png' });
      await expect(service.purge(1, admin)).rejects.toBeInstanceOf(ConflictException);
      expect(deleteImage).not.toHaveBeenCalled();
    });
  });
  describe('remove = lưu trữ (xoá mềm) + restore — Hoàn tác 10 phút', () => {
    const owner = { userId: 7, isAdmin: false, grants: {} } as never;
    const other = { userId: 8, isAdmin: false, grants: {} } as never;
    const archived = (o: Record<string, unknown> = {}) => ({ deleted_at: new Date(Date.now() - 2_000), deleted_by: 7, ...o });

    it('remove KHÔNG xoá dòng: ghi deleted_at + người xoá; 404 nếu đã xoá', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(productRow);
      mockPrisma.product.update.mockResolvedValue(productRow);
      await expect(service.remove(1, owner)).resolves.toEqual({ id: 1, archived: true });
      expect(mockPrisma.product.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { deleted_at: expect.any(Date), deleted_by: 7 } });
      expect(mockTx.product.delete).not.toHaveBeenCalled();
      mockPrisma.product.findUnique.mockResolvedValue({ ...productRow, deleted_at: new Date() });
      await expect(service.remove(1, owner)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('restore: người đã xoá trong 10 phút ⇒ bỏ deleted_at', async () => {
      mockPrisma.product.findFirst.mockResolvedValue(archived());
      mockPrisma.product.update.mockResolvedValue(productRow);
      await service.restore(1, owner);
      expect(mockPrisma.product.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 }, data: { deleted_at: null, deleted_by: null } }));
    });

    it('restore: người khác ⇒ 403 (Quản trị thì được); quá 10 phút ⇒ 410; không có ⇒ 404', async () => {
      mockPrisma.product.findFirst.mockResolvedValue(archived());
      await expect(service.restore(1, other)).rejects.toBeInstanceOf(ForbiddenException);
      mockPrisma.product.update.mockResolvedValue(productRow);
      await expect(service.restore(1, admin)).resolves.toBeDefined();
      mockPrisma.product.findFirst.mockResolvedValue(archived({ deleted_at: new Date(Date.now() - 11 * 60_000) }));
      await expect(service.restore(1, owner)).rejects.toBeInstanceOf(GoneException);
      mockPrisma.product.findFirst.mockResolvedValue(null);
      await expect(service.restore(1, owner)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('purge: không phải Quản trị ⇒ 403, không đụng DB', async () => {
      await expect(service.purge(1, owner)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    });

    it('mã trùng với sản phẩm đã lưu trữ ⇒ 409 nói rõ cách xử lý', async () => {
      mockPrisma.product.findFirst.mockResolvedValue({ id: 3, code: 'CF-1', deleted_at: new Date() });
      await expect(service.create({ name: 'X', code: 'cf-1' } as never, 7)).rejects.toThrow('đang thuộc một sản phẩm đã xoá (lưu trữ)');
    });
  });
});
