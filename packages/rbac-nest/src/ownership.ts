import { statSync, readFileSync } from 'node:fs'

/**
 * Tệp sở hữu (`TRINITY_OWNERSHIP_FILE`, JSON) trong giai đoạn Node + Rust chạy song song (PLAN 4.14, issue T01).
 * Bộ đọc của Rust: `server/crates/trinity-kernel/src/ownership.rs` — cùng định dạng, cùng mặc định (không ghi = `node`).
 *
 * Node đọc lại tệp ở ĐẦU MỖI LƯỢT tick (so thời điểm sửa, kích thước, inode — đổi tên nguyên tử đổi inode), không
 * cần khởi động lại. Job thuộc Rust thì Node bỏ lượt; migrate nền lúc boot chỉ chạy khi `migrate` là `node`.
 * Tệp hỏng: giữ bảng đang dùng và ghi lỗi (một lần cho mỗi phiên bản tệp); chưa có bảng nào thì mọi thứ thuộc Node.
 * Không có khoá chéo tiến trình ở Node: mỗi job chỉ một chủ trong tệp, hai bên cùng đọc một tệp.
 */
export type Owner = 'rust' | 'node'

export interface OwnershipTable {
  jobs: Record<string, Owner>
  migrate: Owner
}

const DEFAULT_TABLE: OwnershipTable = { jobs: {}, migrate: 'node' }

const isOwner = (v: unknown): v is Owner => v === 'rust' || v === 'node'

/** Kiểm tra như `RawFile` của Rust (khoá lạ bị từ chối, giá trị chủ phải là `rust|node`). */
export function parseOwnership(text: string): OwnershipTable {
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('tệp sở hữu phải là đối tượng JSON')
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!['routes', 'jobs', 'migrate'].includes(key)) throw new Error(`khoá lạ "${key}"`)
  }
  if (obj.routes !== undefined && !Array.isArray(obj.routes)) throw new Error('routes phải là mảng')
  const jobs: Record<string, Owner> = {}
  if (obj.jobs !== undefined) {
    if (typeof obj.jobs !== 'object' || obj.jobs === null || Array.isArray(obj.jobs)) throw new Error('jobs phải là đối tượng')
    for (const [name, owner] of Object.entries(obj.jobs as Record<string, unknown>)) {
      if (name.trim() === '' || name.trim() !== name) throw new Error(`tên job "${name}" không hợp lệ`)
      if (!isOwner(owner)) throw new Error(`job "${name}": chủ phải là "rust" hoặc "node"`)
      jobs[name] = owner
    }
  }
  if (obj.migrate !== undefined && !isOwner(obj.migrate)) throw new Error('migrate phải là "rust" hoặc "node"')
  return { jobs, migrate: (obj.migrate as Owner | undefined) ?? 'node' }
}

export interface OwnershipReaderOptions {
  /** Đường dẫn tệp; hàm để đọc lại biến môi trường mỗi lượt. */
  path?: () => string | undefined
  log?: (msg: string) => void
}

export interface OwnershipReader {
  table(): OwnershipTable
  /** Job này hiện do Node chạy không? (mặc định có) */
  nodeRunsJob(name: string): boolean
  /** Node có được chạy migrate nền lúc boot không? */
  nodeRunsMigrate(): boolean
}

export function createOwnershipReader(opts: OwnershipReaderOptions = {}): OwnershipReader {
  const getPath = opts.path ?? (() => process.env.TRINITY_OWNERSHIP_FILE?.trim() || undefined)
  const log = opts.log ?? ((m: string) => console.error(`[ownership] ${m}`))
  let current: OwnershipTable = DEFAULT_TABLE
  let seen: string | null = null // khoá phiên bản tệp đã đọc (hoặc đã báo lỗi)

  const table = (): OwnershipTable => {
    const path = getPath()
    if (!path) {
      seen = null
      return (current = DEFAULT_TABLE)
    }
    let key: string
    try {
      const st = statSync(path)
      key = `${path}|${st.mtimeMs}|${st.size}|${st.ino}`
    } catch (e) {
      key = `${path}|lỗi|${(e as Error).message}`
      if (key !== seen) log(`không đọc được ${path}, giữ bảng đang dùng: ${(e as Error).message}`)
      seen = key
      return current
    }
    if (key === seen) return current
    try {
      current = parseOwnership(readFileSync(path, 'utf8'))
    } catch (e) {
      log(`tệp ${path} hỏng, giữ bảng đang dùng: ${(e as Error).message}`)
    }
    seen = key
    return current
  }

  return {
    table,
    nodeRunsJob: (name) => (table().jobs[name] ?? 'node') === 'node',
    nodeRunsMigrate: () => table().migrate === 'node',
  }
}

/** Bộ đọc dùng chung của tiến trình, đọc `TRINITY_OWNERSHIP_FILE` mỗi lượt. */
export const ownership: OwnershipReader = createOwnershipReader()
