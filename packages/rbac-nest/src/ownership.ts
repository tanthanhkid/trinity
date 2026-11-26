import { readFileSync } from 'node:fs'

/**
 * Tệp sở hữu (`TRINITY_OWNERSHIP_FILE`, JSON) trong giai đoạn Node + Rust chạy song song (PLAN 4.14, issue T01).
 * Bộ đọc của Rust: `server/crates/trinity-kernel/src/ownership.rs` — cùng định dạng, cùng luật kiểm, cùng mặc định
 * (job không ghi = `node`).
 *
 * Node đọc lại tệp ở ĐẦU MỖI LƯỢT tick và so **nội dung** (tệp nhỏ; không dựa vào mtime/size/inode vì ghi cùng cỡ
 * trong cùng một mili giây vẫn phải nhận ra). Job thuộc Rust thì Node bỏ lượt; migrate nền lúc boot chỉ chạy khi
 * `migrate` là `node`.
 *
 * Tệp sai (cú pháp, khoá lạ/trùng, chủ sai, route sai hoặc xung đột): coi là hỏng, giữ bảng đang dùng, ghi lỗi (một
 * lần cho mỗi phiên bản tệp). Khi đã đặt `TRINITY_OWNERSHIP_FILE` mà chưa từng đọc được bảng hợp lệ (hỏng lúc khởi
 * động) thì Node KHÔNG rơi về "mọi thứ thuộc Node" (sẽ chạy trùng với Rust): [`assertOwnershipLoadable`] làm tiến
 * trình từ chối khởi động, và nếu vẫn chạy thì Node bỏ mọi job và migrate, ghi lỗi to.
 * Không có khoá chéo tiến trình ở Node: mỗi job chỉ một chủ trong tệp, hai bên cùng đọc một tệp.
 */
export type Owner = 'rust' | 'node'

export interface OwnershipTable {
  /** Không có khoá nào ngoài tên job trong tệp (Map, không dính `__proto__`/`constructor`). */
  jobs: ReadonlyMap<string, Owner>
  migrate: Owner
}

export interface RouteRule {
  prefix: string
  methods: string[] | null
  owner: Owner
}

const EMPTY_TABLE: OwnershipTable = { jobs: new Map(), migrate: 'node' }
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

const isOwner = (v: unknown): v is Owner => v === 'rust' || v === 'node'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Ném lỗi nếu có khoá trùng trong một đối tượng JSON bất kỳ (Rust/serde từ chối, `JSON.parse` thì im lặng lấy khoá sau). */
export function assertNoDuplicateKeys(text: string): void {
  type Frame = { keys: Set<string> | null; expectKey: boolean }
  const stack: Frame[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const top = stack[stack.length - 1]
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string
        if (top.keys.has(key)) throw new Error(`khoá "${key}" ghi hai lần`)
        top.keys.add(key)
        top.expectKey = false
      }
      i = j + 1
      continue
    }
    if (c === '{') stack.push({ keys: new Set(), expectKey: true })
    else if (c === '[') stack.push({ keys: null, expectKey: false })
    else if (c === '}' || c === ']') stack.pop()
    else if (c === ',') {
      const top = stack[stack.length - 1]
      if (top?.keys) top.expectKey = true
    }
    i++
  }
}

function parseRoute(raw: unknown, index: number): RouteRule {
  const at = `routes[${index}]`
  if (!isObj(raw)) throw new Error(`${at} phải là đối tượng`)
  for (const k of Object.keys(raw)) if (!['prefix', 'methods', 'owner'].includes(k)) throw new Error(`${at}: khoá lạ "${k}"`)
  const p = raw.prefix
  if (typeof p !== 'string') throw new Error(`${at}: thiếu prefix`)
  if (!p.startsWith('/')) throw new Error(`${at}: tiền tố "${p}" phải bắt đầu bằng /`)
  if (p.length > 1 && p.endsWith('/')) throw new Error(`${at}: tiền tố "${p}" không được có / cuối`)
  if (/[?# ]/.test(p) || p.includes('//') || p.split('/').includes('..')) throw new Error(`${at}: tiền tố "${p}" không hợp lệ`)
  if (!isOwner(raw.owner)) throw new Error(`${at}: owner phải là "rust" hoặc "node"`)
  let methods: string[] | null = null
  if ('methods' in raw) {
    const ms = raw.methods
    if (!Array.isArray(ms) || ms.length === 0) throw new Error(`${at}: methods phải là mảng không rỗng (bỏ trường = mọi phương thức)`)
    methods = []
    for (const m of ms) {
      if (typeof m !== 'string' || !METHODS.includes(m)) throw new Error(`${at}: phương thức ${JSON.stringify(m)} không hợp lệ`)
      if (methods.includes(m)) throw new Error(`${at}: phương thức ${m} ghi hai lần`)
      methods.push(m)
    }
    if (methods.includes('GET') && methods.includes('HEAD')) throw new Error(`${at}: GET đã gồm HEAD, bỏ HEAD`)
    if (methods.includes('GET')) methods.push('HEAD')
  }
  return { prefix: p, methods, owner: raw.owner }
}

function routesConflict(a: RouteRule, b: RouteRule): string | null {
  if (a.prefix !== b.prefix) return null
  if (a.methods === null && b.methods === null) return 'mọi phương thức'
  if (a.methods && b.methods) return a.methods.find((m) => b.methods?.includes(m)) ?? null
  return null
}

/** Kiểm đủ như `Ownership::parse` của Rust. Ném lỗi khi tệp sai. */
export function parseOwnership(text: string): OwnershipTable {
  const raw: unknown = JSON.parse(text)
  assertNoDuplicateKeys(text)
  if (!isObj(raw)) throw new Error('tệp sở hữu phải là đối tượng JSON')
  for (const key of Object.keys(raw)) {
    if (!['routes', 'jobs', 'migrate'].includes(key)) throw new Error(`khoá lạ "${key}"`)
  }
  if (raw.routes !== undefined) {
    if (!Array.isArray(raw.routes)) throw new Error('routes phải là mảng')
    const rules: RouteRule[] = []
    raw.routes.forEach((r, idx) => {
      const rule = parseRoute(r, idx)
      for (const prev of rules) {
        const m = routesConflict(prev, rule)
        if (m) throw new Error(`routes[${idx}]: tiền tố "${rule.prefix}" (${m}) đã có chủ ở một dòng trước`)
      }
      rules.push(rule)
    })
  }
  const jobs = new Map<string, Owner>()
  if (raw.jobs !== undefined) {
    if (!isObj(raw.jobs)) throw new Error('jobs phải là đối tượng')
    for (const [name, owner] of Object.entries(raw.jobs)) {
      if (name.trim() === '' || name.trim() !== name) throw new Error(`tên job "${name}" không hợp lệ`)
      if (!isOwner(owner)) throw new Error(`job "${name}": chủ phải là "rust" hoặc "node"`)
      jobs.set(name, owner)
    }
  }
  if (raw.migrate !== undefined && !isOwner(raw.migrate)) throw new Error('migrate phải là "rust" hoặc "node"')
  return { jobs, migrate: raw.migrate ?? 'node' }
}

export interface OwnershipReaderOptions {
  /** Đường dẫn tệp; hàm để đọc lại biến môi trường mỗi lượt. */
  path?: () => string | undefined
  log?: (msg: string) => void
}

export interface OwnershipReader {
  /** Bảng hiện hành; `null` = đã đặt tệp mà chưa từng đọc được bảng hợp lệ. */
  table(): OwnershipTable | null
  /** Job này hiện do Node chạy không? Mặc định có; đã đặt tệp mà tệp chưa từng hợp lệ thì KHÔNG. */
  nodeRunsJob(name: string): boolean
  /** Node có được chạy migrate nền lúc boot không? (cùng quy tắc) */
  nodeRunsMigrate(): boolean
  /** Ném lỗi nếu đã đặt tệp mà không đọc được bảng hợp lệ (dùng lúc khởi động để từ chối chạy). */
  assertLoadable(): void
}

export function createOwnershipReader(opts: OwnershipReaderOptions = {}): OwnershipReader {
  const getPath = opts.path ?? (() => process.env.TRINITY_OWNERSHIP_FILE?.trim() || undefined)
  const log = opts.log ?? ((m: string) => console.error(`[ownership] ${m}`))
  let current: OwnershipTable | null = null
  let lastText: string | null = null // nội dung đã đọc (hoặc đã báo lỗi)
  let lastError: string | null = null
  let lastLoadError: string | null = null

  const table = (): OwnershipTable | null => {
    const path = getPath()
    if (!path) {
      lastText = lastError = lastLoadError = null
      return (current = EMPTY_TABLE)
    }
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (e) {
      const msg = `không đọc được ${path}: ${(e as Error).message}`
      if (msg !== lastError) log(`${msg}; ${current ? 'giữ bảng đang dùng' : 'Node bỏ mọi job và migrate cho tới khi tệp hợp lệ'}`)
      lastError = lastLoadError = msg
      return current
    }
    if (text === lastText) return current
    lastText = text
    lastError = null
    try {
      current = parseOwnership(text)
      lastLoadError = null
    } catch (e) {
      lastLoadError = `tệp ${path} hỏng: ${(e as Error).message}`
      log(`${lastLoadError}; ${current ? 'giữ bảng đang dùng' : 'Node bỏ mọi job và migrate cho tới khi tệp hợp lệ'}`)
    }
    return current
  }

  return {
    table,
    nodeRunsJob: (name) => {
      const t = table()
      return t !== null && (t.jobs.get(name) ?? 'node') === 'node'
    },
    nodeRunsMigrate: () => table()?.migrate === 'node',
    assertLoadable: () => {
      if (table() === null) throw new Error(lastLoadError ?? 'tệp sở hữu không dùng được')
    },
  }
}

/** Bộ đọc dùng chung của tiến trình, đọc `TRINITY_OWNERSHIP_FILE` mỗi lượt. */
export const ownership: OwnershipReader = createOwnershipReader()

/** Gọi lúc khởi động: đã đặt `TRINITY_OWNERSHIP_FILE` mà tệp hỏng/thiếu thì từ chối chạy (như `trinity check-config`). */
export function assertOwnershipLoadable(reader: OwnershipReader = ownership): void {
  try {
    reader.assertLoadable()
  } catch (e) {
    throw new Error(`TRINITY_OWNERSHIP_FILE không dùng được, từ chối khởi động để không chạy trùng job với Rust: ${(e as Error).message}`)
  }
}
