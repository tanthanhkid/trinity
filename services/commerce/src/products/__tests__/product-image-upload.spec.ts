import { BadRequestException } from '@nestjs/common';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  PRODUCT_IMAGE_MAX_BYTES,
  deleteProductImageFile,
  detectImageKind,
  saveProductImage,
} from '../product-image-upload.helper';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);

const asFile = (buf: Buffer): Express.Multer.File =>
  ({ buffer: buf, size: buf.length, mimetype: 'image/png' }) as Express.Multer.File;

describe('detectImageKind', () => {
  it('nhận JPG/PNG/WebP/GIF bằng magic bytes', () => {
    expect(detectImageKind(JPG)?.ext).toBe('jpg');
    expect(detectImageKind(PNG)?.ext).toBe('png');
    expect(detectImageKind(WEBP)?.ext).toBe('webp');
    expect(detectImageKind(Buffer.from('GIF89a....'))?.ext).toBe('gif');
  });

  it('TỪ CHỐI SVG/HTML/rỗng dù client khai mimetype ảnh', () => {
    expect(detectImageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageKind(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectImageKind(Buffer.alloc(0))).toBeNull();
  });
});

describe('saveProductImage', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'prod-img-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lưu file, trả URL tương đối /uploads/products/<tên>.<ext>', async () => {
    const { image_url } = await saveProductImage(asFile(PNG), root);
    expect(image_url).toMatch(/^\/uploads\/products\/\d+_[0-9a-f]{12}\.png$/);
    const saved = await readFile(path.join(root, image_url));
    expect(saved.equals(PNG)).toBe(true);
  });

  it('ext theo NỘI DUNG, không theo mimetype client khai', async () => {
    const { image_url } = await saveProductImage(asFile(JPG), root);
    expect(image_url.endsWith('.jpg')).toBe(true);
  });

  it('400 khi thiếu file / file không phải ảnh / quá 5MB', async () => {
    await expect(saveProductImage(undefined, root)).rejects.toBeInstanceOf(BadRequestException);
    await expect(saveProductImage(asFile(Buffer.from('<svg/>')), root)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const big = { ...asFile(PNG), size: PRODUCT_IMAGE_MAX_BYTES + 1 } as Express.Multer.File;
    await expect(saveProductImage(big, root)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('deleteProductImageFile', () => {
  it('xoá đúng file do upload sinh ra; URL ngoài/traversal/null thì bỏ qua và KHÔNG đụng file lạ', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prod-img-del-'));
    try {
      const { image_url } = await saveProductImage(asFile(PNG), root);
      const file = path.join(root, image_url);
      await expect(readFile(file)).resolves.toBeDefined();
      for (const bad of [null, 'https://cdn.x/a.png', '/uploads/products/../../etc/passwd', '/uploads/other/a.png', 'data:image/png;base64,AA']) {
        expect(await deleteProductImageFile(bad, root)).toBe(false);
      }
      await expect(readFile(file)).resolves.toBeDefined();
      expect(await deleteProductImageFile(image_url, root)).toBe(true);
      await expect(readFile(file)).rejects.toThrow();
      expect(await deleteProductImageFile(image_url, root)).toBe(false); // file đã mất → không ném lỗi
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
