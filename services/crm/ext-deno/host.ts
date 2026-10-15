// ext-host: MỘT tiến trình Deno thường trú chứa mọi chương trình con loại `tool`, mỗi cái là một Worker có quyền riêng.
// Kênh điều khiển = HTTP loopback + token (KHÔNG dùng stdio): `Deno.stdin/stdout` không bị cổng quyền chặn, Worker khách
// đọc stdin được nên sẽ cướp được lời gọi của tool khác nếu stdin là kênh điều khiển.
import type { Gateway } from './ctx.ts'
import type { ToolMeta } from './module.ts'

interface LoadSpec {
  ext: string
  code: string
  net: string[]
  gateway?: Gateway
  inputSchema?: Record<string, unknown>
  description?: string
}
type WorkerMsg =
  | { type: 'ready'; tools: ToolMeta[] }
  | { type: 'init_error'; error: { name: string; message: string } }
  | {
      type: 'result'
      id: number
      ok: boolean
      value?: unknown
      error?: { name: string; message: string }
    }

const BOOTSTRAP = new URL('./worker-bootstrap.ts', import.meta.url).href
const specs = new Map<string, LoadSpec>()
const workers = new Map<string, Worker>()
const waiters = new Map<string, Map<number, (m: WorkerMsg) => void>>()
let nextId = 1

/** Chỉ stdin: dòng đầu = token; sau đó stdin đóng (supervisor chết) ⇒ host tự thoát, không mồ côi. */
async function readToken(): Promise<string> {
  const reader = Deno.stdin.readable.getReader()
  let buf = ''
  while (!buf.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) Deno.exit(0)
    buf += new TextDecoder().decode(value)
  }
  void (async () => {
    while (!(await reader.read()).done);
    Deno.exit(0)
  })()
  return buf.split('\n')[0] ?? ''
}

function spawnWorker(spec: LoadSpec): Promise<ToolMeta[]> {
  const opts = {
    type: 'module',
    deno: {
      permissions: {
        net: spec.net.length ? spec.net : false,
        read: false,
        write: false,
        env: false,
        run: false,
        ffi: false,
        sys: false,
      },
    },
  }
  const w = new Worker(BOOTSTRAP, opts as unknown as WorkerOptions)
  const mine = new Map<number, (m: WorkerMsg) => void>()
  waiters.set(spec.ext, mine)
  workers.set(spec.ext, w)
  const drop = (reason: string) => {
    if (workers.get(spec.ext) === w) workers.delete(spec.ext)
    for (const fn of mine.values())
      fn({ type: 'result', id: 0, ok: false, error: { name: 'WorkerDied', message: reason } })
    mine.clear()
  }
  return new Promise((resolve, reject) => {
    w.onerror = (e) => {
      e.preventDefault()
      drop(e.message)
      reject(new Error(e.message))
    }
    w.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const m = e.data
      if (m.type === 'ready') resolve(m.tools)
      else if (m.type === 'init_error') {
        drop(m.error.message)
        w.terminate()
        reject(new Error(`${m.error.name}: ${m.error.message}`))
      } else mine.get(m.id)?.(m)
    }
    w.postMessage({ type: 'init', code: spec.code, gateway: spec.gateway, inputSchema: spec.inputSchema, description: spec.description })
  })
}

/** Dừng worker và trả lời MỌI lời gọi đang chờ bằng WorkerDied (không để callTool treo vĩnh viễn). */
function killWorker(ext: string, reason: string): void {
  const pending = waiters.get(ext)
  if (pending) {
    for (const fn of pending.values())
      fn({ type: 'result', id: 0, ok: false, error: { name: 'WorkerDied', message: reason } })
    pending.clear()
  }
  workers.get(ext)?.terminate()
  workers.delete(ext)
}

async function callTool(ext: string, tool: string, args: unknown): Promise<Response> {
  const spec = specs.get(ext)
  if (!spec)
    return Response.json(
      { ok: false, error: { name: 'UnknownExt', message: ext } },
      { status: 404 },
    )
  if (!workers.has(ext)) await spawnWorker(spec) // Worker chết (lỗi bất đồng bộ) → dựng lại từ mã đã nạp
  const id = nextId++
  const reply = new Promise<WorkerMsg>((ok) => waiters.get(ext)?.set(id, ok))
  workers.get(ext)?.postMessage({ type: 'call', id, tool, args })
  const m = await reply
  waiters.get(ext)?.delete(id)
  return Response.json(
    m.type === 'result' && m.ok
      ? { ok: true, value: m.value }
      : { ok: false, error: m.type === 'result' ? m.error : null },
  )
}

async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url)
  if (pathname === '/health')
    return Response.json({
      pid: Deno.pid,
      rss: Deno.memoryUsage().rss,
      workers: [...workers.keys()],
    })
  const body = (await req.json()) as Record<string, unknown>
  if (pathname === '/load') {
    const spec = body as unknown as LoadSpec
    specs.set(spec.ext, spec)
    killWorker(spec.ext, 'extension reloaded')
    return Response.json({ tools: await spawnWorker(spec) })
  }
  if (pathname === '/unload') {
    killWorker(String(body.ext), 'extension unloaded')
    specs.delete(String(body.ext))
    return Response.json({ ok: true })
  }
  if (pathname === '/call') return callTool(String(body.ext), String(body.tool), body.args)
  return new Response('not found', { status: 404 })
}

const token = await readToken()
Deno.serve(
  { hostname: '127.0.0.1', port: 0, onListen: ({ port }) => console.log(`READY ${port}`) },
  async (req) => {
    if (req.headers.get('authorization') !== `Bearer ${token}`)
      return new Response('unauthorized', { status: 401 })
    try {
      return await handle(req)
    } catch (e) {
      return Response.json(
        { ok: false, error: { name: 'HostError', message: String(e) } },
        { status: 500 },
      )
    }
  },
)
