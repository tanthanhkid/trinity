import fs from 'node:fs'
import path from 'node:path'
import type { RoleKey } from './roles'

/**
 * MANIFEST dữ liệu thử — `e2e/.seed-manifest.json` (gitignore). Seed và từng flow ghi mục vào NGAY
 * khi tạo xong (test chết giữa chừng vẫn dọn được); `seed/cleanup.teardown.ts` đọc ra xoá theo thứ tự
 * NGƯỢC (con trước cha). Không chứa mật khẩu/token — chỉ id + nhãn + URL xoá.
 *
 * Bản ghi mà API chỉ xoá MỀM (hoặc không có API xoá) ⇒ khai `soft` → cleanup ghi vào
 * `e2e/.cleanup-residual.json` (bảng + id) để người vận hành xoá hẳn. Test KHÔNG chạy SQL.
 */
export const MANIFEST_PATH = path.join(__dirname, '..', '.seed-manifest.json')
export const RESIDUAL_PATH = path.join(__dirname, '..', '.cleanup-residual.json')

export interface ManifestCall {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  data?: unknown
}

export interface ManifestEntry {
  /** Loại bản ghi: contact, deal, role, user, webhook-out, ... */
  kind: string
  id: number | string
  label: string
  /** Thuộc tính tuỳ ý để test tra lại (vd chủ sở hữu). */
  meta?: Record<string, string | number | boolean>
  /** Tài khoản dùng để xoá (mặc định ADMIN). */
  as?: RoleKey
  /** Gọi TRƯỚC khi xoá (vd gỡ vai trò khỏi user, reject đề xuất AI). Lỗi bị bỏ qua. */
  pre?: ManifestCall[]
  /** Đường dẫn DELETE (sau /api/v1). Bỏ trống = không có API xoá (chỉ ghi residual). */
  del?: string
  /** Bảng DB còn lại SAU khi gọi `del` (xoá mềm / không có API xoá). */
  soft?: { table: string; note: string }
}

export interface Manifest {
  runId: string
  createdAt: string
  /** Số bản ghi THẬT (không E2E-) trước khi seed — để so sánh sau cleanup. */
  baseline?: Record<string, number>
  entries: ManifestEntry[]
}

export function readManifest(): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
  } catch {
    return null
  }
}

export function writeManifest(m: Manifest): void {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2))
}

export function startManifest(baseline: Record<string, number>): Manifest {
  // Giữ mục của lần chạy trước chưa được dọn (cleanup bị gián đoạn) để lần này dọn luôn.
  const old = readManifest()?.entries ?? []
  const m: Manifest = { runId: `E2E-${Date.now()}`, createdAt: new Date().toISOString(), baseline, entries: old }
  writeManifest(m)
  return m
}

/** Ghi thêm 1 mục NGAY khi tạo xong. Ghi file đồng bộ ⇒ an toàn với worker đơn; flows chạy workers=1. */
export function record(entry: ManifestEntry): void {
  const m = readManifest() ?? { runId: `E2E-${Date.now()}`, createdAt: new Date().toISOString(), entries: [] }
  m.entries.push(entry)
  writeManifest(m)
}

export function seeded(kind: string, meta?: Record<string, string | number | boolean>): ManifestEntry[] {
  return (readManifest()?.entries ?? []).filter(
    (e) => e.kind === kind && (!meta || Object.entries(meta).every(([k, v]) => e.meta?.[k] === v)),
  )
}

/** Ghi nhanh 1 bản ghi sẽ chỉ bị xoá MỀM (flow đã tự xoá hoặc cleanup sẽ xoá): vào residual theo bảng. */
export function recordSoft(kind: string, id: number | string, label: string, table: string, note: string, del?: string): void {
  record({ kind, id, label, del, soft: { table, note } })
}
