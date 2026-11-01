/** Multi-tenant: ảnh sản phẩm công ty ≠1 nằm dưới `uploads/c<id>/products/`, lệnh xoá không chạm ảnh công ty khác. */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { companyRef, runWithCompany } from '@trinity/prisma';
import { deleteProductImageFile, saveProductImage } from '../product-image-upload.helper';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const file = { buffer: PNG, size: PNG.length, mimetype: 'image/png' } as Express.Multer.File;

describe('ảnh sản phẩm theo công ty', () => {
  const OLD = process.env.MULTI_TENANT;
  let root: string;
  beforeAll(() => (process.env.MULTI_TENANT = 'true'));
  afterAll(() => (OLD === undefined ? delete process.env.MULTI_TENANT : (process.env.MULTI_TENANT = OLD)));
  beforeEach(async () => (root = await mkdtemp(path.join(tmpdir(), 'prod-img-tenant-'))));
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('công ty 1 giữ /uploads/products, công ty 5 lưu /uploads/c5/products', async () => {
    const a = await runWithCompany(companyRef(1), () => saveProductImage(file, root));
    const b = await runWithCompany(companyRef(5), () => saveProductImage(file, root));
    expect(a.image_url).toMatch(/^\/uploads\/products\/[^/]+\.png$/);
    expect(b.image_url).toMatch(/^\/uploads\/c5\/products\/[^/]+\.png$/);
    expect(await readFile(path.join(root, b.image_url))).toEqual(PNG);
  });

  it('công ty khác không xoá được ảnh của công ty 5 (và công ty 5 không xoá ảnh công ty 1)', async () => {
    const a = await runWithCompany(companyRef(1), () => saveProductImage(file, root));
    const b = await runWithCompany(companyRef(5), () => saveProductImage(file, root));
    expect(await runWithCompany(companyRef(1), () => deleteProductImageFile(b.image_url, root))).toBe(false);
    expect(await runWithCompany(companyRef(7), () => deleteProductImageFile(b.image_url, root))).toBe(false);
    expect(await runWithCompany(companyRef(5), () => deleteProductImageFile(a.image_url, root))).toBe(false);
    await expect(stat(path.join(root, b.image_url))).resolves.toBeTruthy();
    expect(await runWithCompany(companyRef(5), () => deleteProductImageFile(b.image_url, root))).toBe(true);
  });
});
