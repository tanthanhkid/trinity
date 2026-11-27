import * as fs from 'node:fs'
import * as path from 'node:path'
import { config } from './config.js'

/**
 * Con trỏ phân trang đi chéo Node ↔ Rust (C14c). Con trỏ trong golden đã qua bộ chuẩn hoá (id thành nhãn) nên không dùng lại được;
 * ở lượt `record` (Node) con trỏ THÔ được ghi riêng `<out>/<hồ sơ>/cursors/<tên>.raw.json`. Ở lượt `compare` (Rust) ca lấy con trỏ thô
 * do Node phát để xin trang kế tiếp từ Rust — và kết quả phải bằng golden của lượt Node. Chiều ngược lại (Rust phát, Node dùng) là
 * cùng bộ ca chạy với vai đổi chỗ: lượt `record` bằng binary Rust làm baseline, lượt `compare` bằng Node.
 * Con trỏ phải giống từng byte (bộ chuẩn hoá không che `next_cursor`), nên ca cũng so con trỏ thô của hai bên.
 */
export function crossCursor(name: string, own: string): string {
  const rel = path.join(config.profile, 'cursors', `${name}.raw.json`)
  if (config.mode === 'record') {
    const f = path.join(config.outDir, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, `${JSON.stringify({ cursor: own })}\n`)
    return own
  }
  const base = process.env.CONTRACT_BASELINE_DIR
  if (!base) throw new Error('CONTRACT_MODE=compare cần CONTRACT_BASELINE_DIR')
  const f = path.join(base, rel)
  if (!fs.existsSync(f)) throw new Error(`Không có con trỏ của bên kia: ${f}`)
  const theirs = (JSON.parse(fs.readFileSync(f, 'utf8')) as { cursor: string }).cursor
  if (theirs !== own) throw new Error(`Con trỏ khác nhau giữa hai bên (${name}): ${own} ≠ ${theirs}`)
  return theirs
}
