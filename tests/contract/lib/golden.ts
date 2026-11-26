import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect } from 'vitest'
import { config } from './config.js'
import { Normalizer } from './normalize.js'
import type { Res } from './http.js'

/** Vai dùng cho golden của route đọc dữ liệu khách: hình dạng response đổi theo quyền (`shape_permissions`). */
export type Role = 'admin' | 'leader' | 'sale' | 'anon'

export interface Snapshot {
  status: number
  body: unknown
}

/** Một `Normalizer` mới cho mỗi ca: nhãn id đánh số lại từ 1, nên không phụ thuộc ca khác chạy trước. */
export function snap(res: Res, normalizer = new Normalizer()): Snapshot {
  return { status: res.status, body: normalizer.normalize(res.body) }
}

const repoRoot = path.resolve(__dirname, '../../..')

/**
 * Ghi hoặc so kết quả đã chuẩn hoá của một ca:
 * - `record` (chạy Node): ghi `<outDir>/<profile>/<ca>.<vai>.json`; `UPDATE_GOLDEN=1` ghi thêm vào `server/contracts/golden/`
 *   (chỉ để xem diff khi review, không phải chuẩn so);
 * - `compare` (chạy Rust ngay sau lượt Node cùng DB và cùng giờ): so với bản vừa ghi; thiếu bản ghi là lỗi.
 */
export function golden(caseName: string, role: Role, value: Snapshot): void {
  const rel = path.join(config.profile, `${caseName}.${role}.json`)
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (config.mode === 'record') {
    const f = path.join(config.outDir, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, text)
    if (config.updateGolden) {
      const g = path.join(repoRoot, 'server/contracts/golden', rel)
      fs.mkdirSync(path.dirname(g), { recursive: true })
      fs.writeFileSync(g, text)
    }
    return
  }
  const base = process.env.CONTRACT_BASELINE_DIR
  if (!base) throw new Error('CONTRACT_MODE=compare cần CONTRACT_BASELINE_DIR (thư mục lượt record)')
  const f = path.join(base, rel)
  if (!fs.existsSync(f)) throw new Error(`Không có bản ghi để so: ${f}`)
  expect(value).toEqual(JSON.parse(fs.readFileSync(f, 'utf8')))
}
