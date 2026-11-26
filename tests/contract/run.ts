/**
 * Bộ chạy test hợp đồng HTTP hộp đen (PLAN mục 6.2). Với mỗi hồ sơ cấu hình (`profiles/*.env`): dựng DB riêng từ mẫu đã
 * migrate + seed, khởi động máy chủ MỘT lần với env của hồ sơ, chạy các ca trong `cases/<hồ sơ>/`, rồi tắt máy chủ.
 *
 *   pnpm --filter @trinity/contract-tests contract                       # Node, mọi hồ sơ có ca
 *   pnpm --filter @trinity/contract-tests contract -- --profile default  # một hồ sơ
 *
 * Chọn máy chủ (`--target`):
 *   node (mặc định)  `node apps/monolith/dist/.../main.js` (luôn build trước; `--no-build` để bỏ qua)
 *   cmd              mảng JSON trong `SERVER_CMD` (vd `["/đường/dẫn/trinity"]`), nhận env của hồ sơ; hồ sơ `production` phải trỏ binary phát hành
 *                    qua `SERVER_CMD_PRODUCTION`
 *
 * So Node với Rust trong CÙNG lượt: `--mode record` (Node, ghi kết quả đã chuẩn hoá vào `--out`), rồi
 * `--mode compare --baseline <thư mục --out của lượt record>` (Rust). Golden commit ở `server/contracts/golden/` chỉ để xem diff
 * (`UPDATE_GOLDEN=1`), không phải chuẩn so.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import pg from 'pg'

const here = __dirname
const root = path.resolve(here, '../..')
const PORT = Number(process.env.CONTRACT_PORT ?? 4310)

function arg(name: string, multi = false): string[] {
  const out: string[] = []
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) if (a[i] === `--${name}` && a[i + 1]) out.push(a[++i])
  return multi ? out : out.slice(0, 1)
}

/** Quanh nửa đêm Việt Nam (17:00 UTC), "hôm nay" đổi giữa lượt chạy làm kết quả chuẩn hoá lệch: từ chối bắt đầu. */
function refuseNearVnMidnight(now = new Date()): void {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes()
  if (m >= 16 * 60 + 50 && m <= 17 * 60 + 10) {
    console.error('Từ chối chạy trong khung 16:50-17:10 UTC (quanh nửa đêm Việt Nam). Chạy lại sau 17:10 UTC.')
    process.exit(2)
  }
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const user = process.env.PGUSER ?? os.userInfo().username
const adminUrl = process.env.CONTRACT_PG_ADMIN_URL ?? `postgresql://${user}@localhost:5432/postgres`
const dbUrl = (name: string): string => adminUrl.replace(/\/[^/]*$/, `/${name}`)

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function recreateDb(name: string, template?: string): Promise<void> {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await c.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`)
  })
}

const ADMIN_EMAIL = 'admin@contract.test'
const ADMIN_PASSWORD = 'Contract-Admin-123'
const SERVICE_SECRET = 'contract-service-secret-0123456789abcdef0123'

function sh(cmd: string, args: string[], env: Record<string, string>, cwd = root): void {
  const r = spawnSync(cmd, args, { cwd, env: { ...cleanBase(), ...env }, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} thoát mã ${r.status}`)
}

/** Môi trường sạch: không thừa hưởng `.env` hay biến của shell, để mọi lượt chạy giống nhau. */
function cleanBase(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'USER', 'LANG', 'SHELL', 'NODE_OPTIONS', 'PNPM_HOME', 'COREPACK_HOME']
  const out: Record<string, string> = {}
  for (const k of keep) if (process.env[k]) out[k] = process.env[k] as string
  return out
}

async function waitHealthy(base: string, child: ChildProcess, ms = 90_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Máy chủ thoát sớm (mã ${child.exitCode ?? child.signalCode})`)
    try {
      const r = await fetch(`${base}/api/v1/health`)
      if (r.status === 200) return
    } catch {
      /* chưa nghe cổng */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Máy chủ không lên trong thời hạn')
}

/** `SERVER_CMD` là mảng JSON (lệnh + đối số), vd `["/đường/dẫn/trinity","--flag"]`: không tách theo khoảng trắng nên đường dẫn có dấu cách vẫn đúng. */
function parseCmd(name: string, raw: string): { cmd: string; args: string[] } {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new Error(`${name} phải là mảng JSON, vd '["/đường/dẫn/trinity"]'`)
  }
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string')) throw new Error(`${name} phải là mảng JSON chuỗi, không rỗng`)
  const [cmd, ...args] = v as string[]
  return { cmd, args }
}

let built = false
function serverCommand(profile: string): { cmd: string; args: string[] } {
  if (arg('target')[0] === 'cmd') {
    const prod = profile === 'production' ? process.env.SERVER_CMD_PRODUCTION : undefined
    const raw = prod ?? process.env.SERVER_CMD
    if (!raw) throw new Error('--target cmd cần SERVER_CMD (và SERVER_CMD_PRODUCTION cho hồ sơ production)')
    return parseCmd(prod ? 'SERVER_CMD_PRODUCTION' : 'SERVER_CMD', raw)
  }
  // Luôn build (tsc ghi đè dist, vài giây): dist cũ sẽ chạy mã không phải của nhánh hiện tại. `--no-build` để bỏ qua có chủ đích.
  if (!built && !process.argv.includes('--no-build')) {
    sh('pnpm', ['--filter', '@trinity/monolith', 'build'], {})
    built = true
  }
  return { cmd: process.execPath, args: [path.join(root, 'apps/monolith/dist/apps/monolith/src/main.js')] }
}

/** Cổng phải trống trước khi khởi động: nếu không, health có thể đến từ tiến trình cũ chứ không phải pid vừa spawn. */
async function assertPortFree(port: number): Promise<void> {
  const used = await new Promise<boolean>((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
  })
  if (used) throw new Error(`Cổng ${port} đang có tiến trình khác lắng nghe; đặt CONTRACT_PORT khác hoặc tắt nó`)
}

/** Đợi tiến trình con thoát (có hạn), rồi mới sang hồ sơ sau: cổng và DB phải được nhả trước. */
async function stopServer(server: ChildProcess): Promise<void> {
  const exited = (): boolean => server.exitCode !== null || server.signalCode !== null
  if (!exited()) server.kill('SIGTERM')
  const wait = async (ms: number): Promise<void> => {
    const end = Date.now() + ms
    while (!exited() && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
  }
  await wait(10_000)
  if (!exited()) {
    server.kill('SIGKILL')
    await wait(5_000)
  }
  if (!exited()) throw new Error(`Máy chủ pid ${server.pid} không thoát; dừng để không chồng cổng ${PORT}`)
}

async function main(): Promise<void> {
  refuseNearVnMidnight()
  const mode = arg('mode')[0] ?? 'record'
  const baseline = arg('baseline')[0]
  const outDir = path.resolve(arg('out')[0] ?? path.join(here, '.out', new Date().toISOString().replace(/[:.]/g, '-')))
  if (mode === 'compare' && !baseline) throw new Error('--mode compare cần --baseline <thư mục record>')
  const wanted = arg('profile', true)
  const profiles = wanted.length
    ? wanted
    : fs.readdirSync(path.join(here, 'cases')).filter((d) => fs.statSync(path.join(here, 'cases', d)).isDirectory())
  for (const p of profiles) {
    if (!fs.existsSync(path.join(here, 'profiles', `${p}.env`))) throw new Error(`Không có hồ sơ profiles/${p}.env`)
  }

  const unit = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.config.ts'], { cwd: here, env: { ...cleanBase(), CONTRACT_UNIT: '1', TZ: 'UTC' }, stdio: 'inherit' })
  if (unit.status !== 0) throw new Error('Test đơn vị của bộ chuẩn hoá đỏ')

  const dbPrefix = process.env.CONTRACT_DB_PREFIX ?? 'trinity_contract' // đặt tiền tố riêng khi nhiều lượt chạy cùng máy
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(dbPrefix)) throw new Error(`CONTRACT_DB_PREFIX không hợp lệ (cần /^[a-z][a-z0-9_]{0,40}$/): ${dbPrefix}`)
  const tpl = `${dbPrefix}_tpl`
  console.log(`[contract] dựng DB mẫu ${tpl} (migrate + seed admin)`)
  await recreateDb(tpl)
  const dbEnv = {
    DATABASE_URL: dbUrl(tpl),
    SEED_ADMIN_EMAIL: ADMIN_EMAIL,
    SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
    SEED_DEMO_DATA: 'false',
    NODE_ENV: 'test',
  }
  sh('pnpm', ['--filter', '@trinity/prisma', 'exec', 'prisma', 'migrate', 'deploy'], dbEnv)
  sh('pnpm', ['--filter', '@trinity/prisma', 'seed'], dbEnv)

  const defaults = parseEnvFile(path.join(here, 'profiles', 'default.env'))
  let failed = false
  try {
    for (const profile of profiles) {
      const dbName = `${dbPrefix}_${profile.replace(/[^a-z0-9]/g, '_')}`
      await recreateDb(dbName, tpl)
      const base = `http://127.0.0.1:${PORT}`
      const env: Record<string, string> = {
        ...cleanBase(),
        ...defaults,
        ...(profile === 'default' ? {} : parseEnvFile(path.join(here, 'profiles', `${profile}.env`))),
        PORT: String(PORT),
        DATABASE_URL: dbUrl(dbName),
        JWT_SECRET: 'contract-jwt-secret-0123456789abcdef0123456789',
        SERVICE_SECRET,
        INTERNAL_SERVICE_SECRET: SERVICE_SECRET,
        STORAGE_LOCAL_ROOT: path.join(os.tmpdir(), `${dbPrefix}-storage-${profile}`),
        LISTEN_HOST: '127.0.0.1',
        TZ: 'UTC',
      }
      // Hồ sơ ghi đè bí mật (production) thắng giá trị chung.
      for (const k of ['JWT_SECRET', 'SERVICE_SECRET', 'INTERNAL_SERVICE_SECRET']) {
        const own = profile === 'default' ? undefined : parseEnvFile(path.join(here, 'profiles', `${profile}.env`))[k]
        if (own) env[k] = own
      }
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `trinity-contract-${profile}-`))
      const { cmd, args } = serverCommand(profile)
      console.log(`[contract] hồ sơ ${profile}: khởi động máy chủ (${cmd} ${args.join(' ')})`)
      await assertPortFree(PORT)
      const server = spawn(cmd, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const logFile = fs.createWriteStream(path.join(work, 'server.log'))
      server.stdout?.pipe(logFile)
      server.stderr?.pipe(logFile)
      try {
        await waitHealthy(base, server)
        const testEnv = {
          ...cleanBase(),
          CONTRACT_BASE_URL: base,
          CONTRACT_DATABASE_URL: dbUrl(dbName),
          SERVICE_SECRET: env.SERVICE_SECRET,
          CONTRACT_ADMIN_EMAIL: ADMIN_EMAIL,
          CONTRACT_ADMIN_PASSWORD: ADMIN_PASSWORD,
          CONTRACT_PROFILE: profile,
          CONTRACT_MODE: mode,
          CONTRACT_OUT_DIR: outDir,
          ...(baseline ? { CONTRACT_BASELINE_DIR: path.resolve(baseline) } : {}),
          ...(process.env.UPDATE_GOLDEN ? { UPDATE_GOLDEN: process.env.UPDATE_GOLDEN } : {}),
          TZ: 'UTC',
        }
        const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.config.ts'], { cwd: here, env: testEnv, stdio: 'inherit' })
        if (r.status !== 0) {
          failed = true
          console.error(`[contract] hồ sơ ${profile} ĐỎ. Log máy chủ: ${path.join(work, 'server.log')}`)
        }
      } catch (e) {
        failed = true
        console.error(`[contract] hồ sơ ${profile}: ${(e as Error).message}. Log máy chủ: ${path.join(work, 'server.log')}`)
      } finally {
        await stopServer(server)
        await admin((c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`))
      }
    }
  } finally {
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${tpl}" WITH (FORCE)`))
  }
  console.log(failed ? '[contract] CÓ HỒ SƠ ĐỎ' : `[contract] xanh; kết quả đã chuẩn hoá ở ${outDir}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
