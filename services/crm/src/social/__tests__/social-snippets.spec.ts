import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialSnippetsService, normalizeHashtags } from '../social-snippets.service';

const user = { userId: 7 } as never;

function setup(over: { count?: number; row?: Record<string, unknown> | null } = {}) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    socialSnippet: {
      updateMany: jest.fn().mockResolvedValue({}),
      aggregate: jest.fn().mockResolvedValue({ _max: { position: 2 } }),
      count: jest.fn().mockResolvedValue(over.count ?? 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 5, ...data })),
    },
  };
  const prisma = {
    socialSnippet: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(over.count ?? 0),
      findUnique: jest.fn().mockResolvedValue(over.row === undefined ? { id: 5, kind: 'signature', name: 'a', content: 'b', is_default: false } : over.row),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { svc: new SocialSnippetsService(prisma as never), prisma, tx };
}

describe('normalizeHashtags', () => {
  it('bỏ trùng cả khi khác dạng Unicode (NFC / NFD của chữ có dấu)', () => {
    expect(normalizeHashtags(`#khaigiảng ${'#khaigiảng'.normalize('NFD')}`)).toBe('#khaigiảng');
  });
  it('tách theo khoảng trắng/phẩy, thêm #, bỏ trùng không phân biệt hoa thường', () => {
    expect(normalizeHashtags('khaigiang, #KhaiGiang  #hoc\n#Hoc,lap-trinh')).toBe('#khaigiang #hoc #lap-trinh');
  });
  it('từ chối thẻ quá dài hoặc chứa # ở giữa', () => {
    expect(() => normalizeHashtags('a'.repeat(101))).toThrow(BadRequestException);
    expect(() => normalizeHashtags('#a#b')).toThrow(BadRequestException);
  });
});

describe('SocialSnippetsService', () => {
  it('list lọc theo kind và từ chối kind lạ', async () => {
    const { svc, prisma } = setup();
    await svc.list('hashtags');
    expect(prisma.socialSnippet.findMany.mock.calls[0][0].where).toEqual({ kind: 'hashtags' });
    await expect(svc.list('x')).rejects.toThrow(BadRequestException);
  });

  it('create hashtags: chuẩn hoá nội dung, position nối tiếp, created_by', async () => {
    const { svc, tx } = setup();
    const r = await svc.create(user, { kind: 'hashtags', name: ' Khai giảng ', content: 'a b A' });
    expect(r).toMatchObject({ kind: 'hashtags', name: 'Khai giảng', content: '#a #b', position: 3, is_default: false, created_by: 7 });
    expect(tx.socialSnippet.updateMany).not.toHaveBeenCalled();
  });

  it('create: kiểm tên/nội dung/kind', async () => {
    const { svc } = setup();
    await expect(svc.create(user, { kind: 'x', name: 'a', content: 'b' })).rejects.toThrow(BadRequestException);
    await expect(svc.create(user, { kind: 'signature', name: '  ', content: 'b' })).rejects.toThrow(BadRequestException);
    await expect(svc.create(user, { kind: 'signature', name: 'a'.repeat(81), content: 'b' })).rejects.toThrow(BadRequestException);
    await expect(svc.create(user, { kind: 'signature', name: 'a', content: '' })).rejects.toThrow(BadRequestException);
    await expect(svc.create(user, { kind: 'signature', name: 'a', content: 'x'.repeat(2001) })).rejects.toThrow(BadRequestException);
  });

  it('create: tối đa 100 mẫu — đếm dưới khoá advisory trong transaction', async () => {
    const { svc, tx } = setup({ count: 100 });
    await expect(svc.create(user, { kind: 'signature', name: 'a', content: 'b' })).rejects.toThrow(/Tối đa 100/);
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.socialSnippet.count).toHaveBeenCalled();
  });

  it('is_default chỉ cho chữ ký', async () => {
    const { svc } = setup();
    await expect(svc.create(user, { kind: 'hashtags', name: 'a', content: 'b', is_default: true })).rejects.toThrow(BadRequestException);
  });

  it('create chữ ký mặc định: bỏ cờ của các chữ ký khác trong cùng transaction', async () => {
    const { svc, tx, prisma } = setup();
    const r = await svc.create(user, { kind: 'signature', name: 'Chữ ký', content: 'Trân trọng', is_default: true });
    expect(r.is_default).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(tx.socialSnippet.updateMany).toHaveBeenCalledWith({ where: { kind: 'signature', is_default: true }, data: { is_default: false } });
  });

  it('update: chỉ trường có gửi; đặt mặc định bỏ cờ cái khác; không đổi kind', async () => {
    const { svc, tx } = setup();
    await svc.update(5, { is_default: true });
    expect(tx.socialSnippet.update.mock.calls[0][0].data).toEqual({ is_default: true });
    expect(tx.socialSnippet.updateMany.mock.calls[0][0].where).toEqual({ kind: 'signature', is_default: true, id: { not: 5 } });
    await expect(svc.update(5, { kind: 'hashtags' })).rejects.toThrow(BadRequestException);
  });

  it('update hashtags chuẩn hoá nội dung; hashtags không đặt được mặc định', async () => {
    const { svc, tx } = setup({ row: { id: 5, kind: 'hashtags', name: 'a', content: '#a', is_default: false } });
    await svc.update(5, { content: 'x, y' });
    expect(tx.socialSnippet.update.mock.calls[0][0].data).toEqual({ content: '#x #y' });
    await expect(svc.update(5, { is_default: true })).rejects.toThrow(BadRequestException);
  });

  it('update/remove: 404 khi không có', async () => {
    const { svc, prisma } = setup({ row: null });
    await expect(svc.update(9, { name: 'a' })).rejects.toThrow(NotFoundException);
    prisma.socialSnippet.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.remove(9)).rejects.toThrow(NotFoundException);
  });
});
