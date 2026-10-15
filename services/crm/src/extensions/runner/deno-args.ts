import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Thư mục `ext-deno/` (mã tin cậy chạy trong tiến trình Deno, KHÔNG biên dịch bằng tsc). Tìm lên từ chỗ file này đang chạy:
 * khi chạy từ mã nguồn hoặc từ bản build — `ext-deno` nằm ở
 * `services/crm/ext-deno` của cây mã. `EXT_DENO_DIR` ghi đè.
 */
export function resolveDenoDir(): string {
  const forced = process.env.EXT_DENO_DIR?.trim()
  if (forced && existsSync(join(forced, 'host.ts'))) return resolve(forced)
  let dir = __dirname
  for (let i = 0; i < 12; i++) {
    for (const rel of ['ext-deno', join('services', 'crm', 'ext-deno')]) {
      if (existsSync(join(dir, rel, 'host.ts'))) return resolve(dir, rel)
    }
    dir = dirname(dir)
  }
  throw new Error('không thấy thư mục ext-deno của chương trình con')
}

let cached: ReturnType<typeof buildFiles> | undefined
function buildFiles(d: string) {
  return { jobMain: join(d, 'job-main.ts'), host: join(d, 'host.ts'), bootstrap: join(d, 'worker-bootstrap.ts'), ctx: join(d, 'ctx.ts'), module: join(d, 'module.ts') }
}
export const denoFiles = () => (cached ??= buildFiles(resolveDenoDir()))

/** Cờ chung: không hỏi quyền, không tải module ngoài, không đọc config/lock. */
const BASE = ['run', '--no-prompt', '--no-remote', '--no-npm', '--no-config', '--no-lock', '--quiet']

/**
 * Lưới chặn THỨ HAI cho DNS-rebinding (đã đo với Deno 2.9.3: `--allow-net=127.0.0.1.nip.io` chạm được 127.0.0.1:<cổng>, còn `--deny-net` thì chặn
 * theo IP đã phân giải): mạng riêng/link-local bị cấm cả khối; loopback chỉ cấm các cổng dịch vụ của máy (cổng cổng-nội-bộ là ephemeral nên không dính).
 */
export const DENY_NET: readonly string[] = [
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8',
  ...[22, 25, 80, 443, 3000, 3002, 3306, 4000, 4007, 5432, 5433, 6379, 8080, 9200, 9222, 27017].flatMap((p) => [`127.0.0.1:${p}`, `[::1]:${p}`]),
];
const denyNet = `--deny-net=${DENY_NET.join(',')}`;

const heap = (memoryMb: number): string => `--v8-flags=--max-old-space-size=${memoryMb}`

/**
 * Job / chạy thử: CHỈ `--allow-net=<host đã khai>`. Không allow-read/write/env/run/ffi/sys.
 * Danh sách rỗng ⇒ không truyền cờ net (truyền `--allow-net=` trống nghĩa là mở hết ở một số bản Deno).
 */
export function buildJobArgs(net: string[], memoryMb: number): string[] {
  const args = [...BASE]
  if (net.length > 0) args.push(`--allow-net=${net.join(',')}`, denyNet)
  args.push(heap(memoryMb), denoFiles().jobMain)
  return args
}

/**
 * ext-host: cần `--unstable-worker-options` (Worker `deno.permissions`) và `--allow-net` đầy đủ vì quyền Worker chỉ được THU HẸP
 * từ quyền cha. Host là mã tin cậy; quyền thật của từng chương trình con nằm ở Worker. Chỉ đọc đúng các file bootstrap.
 */
export function buildHostArgs(memoryMb: number): string[] {
  const f = denoFiles()
  return [...BASE, '--unstable-worker-options', '--allow-net', denyNet, `--allow-read=${f.bootstrap},${f.ctx},${f.module}`, heap(memoryMb), f.host]
}

/** Env tối thiểu cho tiến trình Deno (không chuyển secret của monolith sang). */
export function cleanEnv(): NodeJS.ProcessEnv {
  const { HOME, PATH, DENO_DIR } = process.env
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' }
  if (HOME) env.HOME = HOME
  if (PATH) env.PATH = PATH
  if (DENO_DIR) env.DENO_DIR = DENO_DIR
  return env
}
