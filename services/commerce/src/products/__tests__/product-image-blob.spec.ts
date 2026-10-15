import {
  deleteProductImageFile,
  saveProductImage,
} from '../product-image-upload.helper';

// STORAGE_DRIVER=vercel-blob: ảnh sản phẩm lên Blob key `uploads/products/<tên>`,
// URL lưu DB vẫn là `/uploads/products/<tên>` (web route /uploads đọc lại từ Blob).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('product image — vercel-blob', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.STORAGE_DRIVER = 'vercel-blob';
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store_placeholder';
  });
  afterEach(() => {
    process.env = { ...OLD };
    jest.restoreAllMocks();
  });

  it('lưu ảnh qua REST Blob, trả URL /uploads/products/… không đổi', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const file = { buffer: PNG, size: PNG.length, mimetype: 'image/png' } as Express.Multer.File;
    const { image_url } = await saveProductImage(file);
    expect(image_url).toMatch(/^\/uploads\/products\/\d+_[0-9a-f]{12}\.png$/);
    const [url, init] = fetchMock.mock.calls[0];
    const name = image_url.split('/').pop() as string;
    expect(String(url)).toBe(`https://vercel.com/api/blob/?pathname=${encodeURIComponent(`uploads/products/${name}`)}`);
    expect((init?.headers as Record<string, string>)['x-content-type']).toBe('image/png');
  });

  it('xoá ảnh gọi POST /delete với URL store; URL ngoài bị bỏ qua', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(deleteProductImageFile('/uploads/products/1_ab.png')).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://vercel.com/api/blob/delete');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      urls: ['https://store.public.blob.vercel-storage.com/uploads/products/1_ab.png'],
    });
    fetchMock.mockClear();
    await expect(deleteProductImageFile('https://cdn.x/a.png')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
