import { PosCatalogService } from '../pos-catalog.service';

describe('PosCatalogService.menu category filter', () => {
  const build = (cats: number[]) => {
    const prisma = {
      posSettings: { upsert: jest.fn(), findUnique: jest.fn().mockResolvedValue({ id: 1, menu_category_ids: cats }), create: jest.fn() },
      productCategory: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new PosCatalogService(prisma as never);
    jest.spyOn(service, 'getSettings').mockResolvedValue({ id: 1, menu_category_ids: cats } as never);
    return { service, prisma };
  };
  const whereOf = (prisma: ReturnType<typeof build>['prisma']) => prisma.product.findMany.mock.calls[0][0].where;

  it('category_id ngoài menu_category_ids → không trả sản phẩm ngoài menu', async () => {
    const { service, prisma } = build([1, 2]);
    await service.menu({ category_id: 9 } as never);
    expect(whereOf(prisma).category_id).toEqual({ in: [] });
  });

  it('category_id nằm trong menu → lọc đúng danh mục đó', async () => {
    const { service, prisma } = build([1, 2]);
    await service.menu({ category_id: 2 } as never);
    expect(whereOf(prisma).category_id).toBe(2);
  });

  it('không cấu hình menu → category_id tự do; không category_id → giới hạn theo menu', async () => {
    const a = build([]);
    await a.service.menu({ category_id: 9 } as never);
    expect(whereOf(a.prisma).category_id).toBe(9);
    const b = build([1, 2]);
    await b.service.menu({} as never);
    expect(whereOf(b.prisma).category_id).toEqual({ in: [1, 2] });
  });
});
