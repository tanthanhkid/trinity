import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { createUploadsStore, type UploadsStore } from '@trinity/storage';

/** Trần dung lượng ảnh minh hoạ sản phẩm — khớp FE `PRODUCT_IMAGE_MAX_BYTES`. */
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Thư mục con trong `uploads/` — `apps/monolith` phục vụ tĩnh ở `/uploads` (xem `main.ts`);
 * `STORAGE_DRIVER=vercel-blob`: lưu Blob key `uploads/products/<tên>`, web route
 * `/uploads/[...path]` đọc lại — URL lưu trong DB không đổi.
 */
export const PRODUCT_IMAGE_SUBDIR = 'products';

type ImageKind = { ext: 'jpg' | 'png' | 'webp' | 'gif'; mime: string };

/**
 * Nhận diện định dạng bằng MAGIC BYTES, KHÔNG tin `mimetype`/tên file do client
 * gửi — tránh nhét HTML/SVG/script vào thư mục được phục vụ tĩnh. SVG cố ý KHÔNG
 * được nhận (chứa script được).
 */
export function detectImageKind(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))) {
    return { ext: 'gif', mime: 'image/gif' };
  }
  return null;
}

/** `root` (test/legacy) ép nhánh đĩa dưới `<root>/uploads`; bỏ trống → theo env (đĩa mặc định hoặc Blob). */
function uploadsStoreFor(root?: string): UploadsStore {
  return createUploadsStore(root ? { localRoot: path.join(root, 'uploads') } : {});
}

/** Lưu ảnh đã validate xuống kho uploads, trả URL tương đối `/uploads/products/<tên>` để gán vào `image_url`. */
export async function saveProductImage(
  file: Express.Multer.File | undefined,
  root?: string,
): Promise<{ image_url: string }> {
  if (!file || !file.buffer) throw new BadRequestException('Vui lòng chọn ảnh để tải lên');
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
    throw new BadRequestException(
      `Ảnh quá lớn: ${(file.size / 1024 / 1024).toFixed(1)}MB. Tối đa ${PRODUCT_IMAGE_MAX_BYTES / 1024 / 1024}MB.`,
    );
  }
  const kind = detectImageKind(file.buffer);
  if (!kind) {
    throw new BadRequestException('Định dạng ảnh không hợp lệ. Chỉ chấp nhận JPG, PNG, WebP, GIF.');
  }
  const name = `${Date.now()}_${randomBytes(6).toString('hex')}.${kind.ext}`;
  await uploadsStoreFor(root).save(`${PRODUCT_IMAGE_SUBDIR}/${name}`, file.buffer, kind.mime);
  return { image_url: `/uploads/${PRODUCT_IMAGE_SUBDIR}/${name}` };
}

/** Chỉ nhận đúng dạng do `saveProductImage` sinh ra — chặn `..`, đường dẫn tuyệt đối, URL ngoài. */
const OWN_IMAGE_URL = /^\/uploads\/products\/([A-Za-z0-9_-]+\.(?:jpg|png|webp|gif))$/;

/**
 * Xoá file ảnh trên đĩa của sản phẩm vừa bị xoá cứng. Best-effort: chỉ file do chính
 * upload của sản phẩm tạo (`/uploads/products/<tên>`); URL ngoài/data URI bỏ qua; file không còn → bỏ qua.
 * Trả `true` nếu đã xoá file. Caller PHẢI kiểm không sản phẩm nào khác còn dùng cùng URL.
 */
export async function deleteProductImageFile(
  imageUrl: string | null,
  root?: string,
): Promise<boolean> {
  const m = imageUrl ? OWN_IMAGE_URL.exec(imageUrl) : null;
  if (!m) return false;
  return uploadsStoreFor(root).remove(`${PRODUCT_IMAGE_SUBDIR}/${m[1]}`);
}
