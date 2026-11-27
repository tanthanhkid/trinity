/**
 * K30 — golden ảnh dùng chung với Rust (`server/crates/trinity-docgen/src/image.rs`): chạy ĐÚNG chuỗi sharp của bản
 * Node trên 11 ảnh mẫu (`server/crates/trinity-docgen/tests/fixtures/images/`, gồm ảnh có EXIF Orientation 3/6/8,
 * PNG có alpha, PNG 4 ô màu (kiểm vùng cắt), WebP, GIF, ảnh nhỏ hơn khung, ảnh rất dẹt, JPEG hồ sơ màu Display P3) và
 * so kích thước, định dạng và màu tại 5 điểm (giữa 4 phần tư và gần góc dưới trái) của ảnh đầu ra với
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
const avatar = (buf: Buffer) => sharp(buf).rotate().resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
/** `newsfeed.service.ts` (ảnh bảng tin). */
const newsfeed = (buf: Buffer) =>
  sharp(buf).rotate().resize(1920, 1920, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();

async function shape(buf: Buffer) {
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height, format: m.format, orientation: m.orientation ?? null };
}

/** Màu RGBA tại 5 điểm của ảnh (đã đưa về sRGB như khi trình duyệt hiển thị). */
async function samples(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.1, 0.9]].map(([fx, fy]) => {
    const x = Math.min(info.width - 1, Math.floor(info.width * fx));
    const y = Math.min(info.height - 1, Math.floor(info.height * fy));
    const i = (y * info.width + x) * 4;
    return { x, y, rgba: [...data.subarray(i, i + 4)] };
  });
}

async function out(buf: Buffer) {
  return { ...(await shape(buf)), samples: await samples(buf) };
}

describe('golden ảnh (sharp ↔ Rust)', () => {
  it('11 ảnh mẫu: kích thước, định dạng, màu đầu ra của bản Node khớp bảng', async () => {
    const files = readdirSync(DIR).filter((f) => !f.startsWith('.')).sort();
    expect(files).toHaveLength(11);
    const rows = [];
    for (const file of files) {
      const buf = readFileSync(join(DIR, file));
      rows.push({ file, input: await shape(buf), avatar: await out(await avatar(buf)), newsfeed: await out(await newsfeed(buf)) });
    }
    const golden = {
      _doc: 'K30: kích thước + định dạng đầu ra của sharp (bản Node) trên ảnh mẫu, và màu RGBA (sRGB) tại 5 điểm; Rust (trinity-docgen::image) phải ra cùng kích thước/định dạng và màu lệch không quá ngưỡng (nén có mất dữ liệu). sharp xoay theo EXIF (.rotate(), #310) và bỏ EXIF ở đầu ra (orientation null).',
      cases: rows,
    };
    if (process.env.UPDATE_IMAGE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`);
    expect(JSON.parse(readFileSync(GOLDEN, 'utf8'))).toEqual(golden);
  });
});
