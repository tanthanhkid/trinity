/**
 * K30 — golden ảnh dùng chung với Rust (`server/crates/trinity-docgen/src/image.rs`): chạy ĐÚNG chuỗi sharp của bản
 * Node trên 10 ảnh mẫu (`server/crates/trinity-docgen/tests/fixtures/images/`, gồm ảnh có EXIF Orientation 3/6/8,
 * PNG có alpha, WebP, GIF, ảnh nhỏ hơn khung, ảnh rất dẹt) và so kích thước + định dạng đầu ra với
 * `server/contracts/cases/images.json`. Rust kiểm cùng bảng ở `tests/image_golden.rs`.
 * Ghi lại bảng: `UPDATE_IMAGE_GOLDEN=1 pnpm --filter @trinity/crm exec jest docgen-image-golden`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(__dirname, '../../../../../..');
const DIR = join(ROOT, 'server/crates/trinity-docgen/tests/fixtures/images');
const GOLDEN = join(ROOT, 'server/contracts/cases/images.json');

/** `auth.service.ts` (avatar) và `employees.service.ts` (ảnh nhân viên). */
const avatar = (buf: Buffer) => sharp(buf).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
/** `newsfeed.service.ts` (ảnh bảng tin). */
const newsfeed = (buf: Buffer) =>
  sharp(buf).resize(1920, 1920, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();

async function shape(buf: Buffer) {
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height, format: m.format, orientation: m.orientation ?? null };
}

describe('golden ảnh (sharp ↔ Rust)', () => {
  it('10 ảnh mẫu: kích thước + định dạng đầu ra của bản Node khớp bảng', async () => {
    const files = readdirSync(DIR).filter((f) => !f.startsWith('.')).sort();
    expect(files).toHaveLength(10);
    const rows = [];
    for (const file of files) {
      const buf = readFileSync(join(DIR, file));
      rows.push({ file, input: await shape(buf), avatar: await shape(await avatar(buf)), newsfeed: await shape(await newsfeed(buf)) });
    }
    const golden = {
      _doc: 'K30: kích thước + định dạng đầu ra của sharp (bản Node) trên ảnh mẫu; Rust (trinity-docgen::image) phải ra giống hệt. sharp không tự xoay theo EXIF và bỏ EXIF ở đầu ra (orientation null).',
      cases: rows,
    };
    if (process.env.UPDATE_IMAGE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`);
    expect(JSON.parse(readFileSync(GOLDEN, 'utf8'))).toEqual(golden);
  });
});
