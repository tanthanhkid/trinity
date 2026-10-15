import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { CallResult, ToolMeta } from './types'
import { buildHostArgs, cleanEnv } from './deno-args'
import { rssKb, summarizeCrash, TailBuffer, watchRss } from './proc'

export interface LoadSpec {
  ext: string
  code: string
  net: string[]
  gateway?: { url: string; token: string }
  inputSchema?: Record<string, unknown>
  description?: string
}

export interface ExtHostOptions {
  denoBin?: string
  memoryMb: number
  /** Trần RSS cả host (MB), canh bằng poll vì V8 không chặn bộ nhớ ngoài heap. Mặc định memoryMb + 192. */
  rssLimitMb?: number
  /** Số lần dựng lại liên tiếp tối đa (không có lần nào "khoẻ" xen giữa) trước khi bỏ cuộc. */
  maxRestarts?: number
  /** Gọi mỗi khi host chết ngoài ý muốn (không phải do supervisor kill vì quá giờ). Quy lỗi cho ext dựa vào kết quả từng lời gọi. */
  onCrash?: (info: { stderrTail: string }) => void
}

type HostState = 'stopped' | 'starting' | 'up' | 'failed'

/**
 * Quản MỘT tiến trình Deno ext-host: sinh, nạp lại các chương trình con sau khi chết, kill khi lời gọi quá giờ.
 * Worker.terminate() KHÔNG dừng được Worker đang vòng lặp đồng bộ vô tận (đã đo) ⇒ quá giờ = kill cả host rồi dựng lại.
 */
export class ExtHost {
  state: HostState = 'stopped'
  restarts = 0
  spawnToReadyMs: number[] = []
  private child?: ChildProcess
  private port = 0
  private token = ''
  private readonly specs = new Map<string, LoadSpec>()
  private readonly opts: ExtHostOptions
  private stderr = new TailBuffer(8 * 1024)
  private starting?: Promise<void>
  private gen = 0
  private readyReported = false
  private readonly rssKilledGens = new Set<number>()
  private stopWatch: () => void = () => {}
  /** Các đời tiến trình bị CHÍNH supervisor kill vì lời gọi quá giờ (khác với tự chết). */
  private readonly killedGens = new Set<number>()
  private recovering?: Promise<void>
  private recovered?: () => void

  constructor(opts: ExtHostOptions) {
    this.opts = opts
  }

  /** Đã bỏ cuộc sau nhiều lần chết liên tiếp — chỉ `reset()` mới dựng lại được. */
  get isFailed(): boolean {
    return this.state === 'failed'
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  rss(): Promise<number | null> {
    return this.pid ? rssKb(this.pid) : Promise.resolve(null)
  }

  /** Nạp (hoặc nạp lại) một chương trình con; trả danh sách tool nó khai. */
  async load(spec: LoadSpec): Promise<ToolMeta[]> {
    this.specs.set(spec.ext, spec)
    await this.ensureUp()
    const r = await this.post('/load', spec, 10_000)
    if (!r.ok) throw new Error(`nạp ${spec.ext} lỗi: ${r.message}`)
    return (r.value as { tools: ToolMeta[] }).tools
  }

  async unload(ext: string): Promise<void> {
    this.specs.delete(ext)
    if (this.state === 'up') await this.post('/unload', { ext }, 3000)
  }

  async call(ext: string, tool: string, args: unknown, timeoutMs: number): Promise<CallResult> {
    try {
      await this.ensureUp()
    } catch (e) {
      return { ok: false, kind: 'host_unavailable', message: String(e) }
    }
    const r = await this.post('/call', { ext, tool, args }, timeoutMs)
    if (!r.ok) return r
    const body = r.value as {
      ok: boolean
      value?: unknown
      error?: { name: string; message: string }
    }
    if (body.ok) return { ok: true, value: body.value }
    const kind = body.error?.name === 'UnknownTool' ? 'unknown_tool' : 'tool_error'
    return { ok: false, kind, message: `${body.error?.name}: ${body.error?.message}` }
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
    const c = this.child
    if (!c || c.exitCode !== null) return
    await new Promise<void>((ok) => {
      c.once('exit', () => ok())
      c.kill('SIGKILL')
    })
  }

  /** Cho phép dựng lại sau khi đã `failed` (admin bấm "thử lại"). */
  async reset(): Promise<void> {
    this.restarts = 0
    this.state = 'stopped'
    await this.ensureUp()
  }

  ensureUp(): Promise<void> {
    if (this.recovering) return this.recovering.then(() => this.ensureUp()) // đang dựng lại sau khi bị kill: chờ, đừng gọi vào tiến trình sắp chết
    if (this.state === 'up') return Promise.resolve()
    if (this.state === 'failed')
      return Promise.reject(new Error('ext-host đã bỏ cuộc sau nhiều lần chết liên tiếp'))
    this.starting ??= this.start()
    return this.starting
  }

  private async start(): Promise<void> {
    try {
      await this.spawnAndLoad()
    } finally {
      this.starting = undefined // đồng bộ với lúc xong, để người gọi ngay sau đó không nhận lại promise cũ
    }
  }

  private async spawnAndLoad(): Promise<void> {
    this.state = 'starting'
    this.readyReported = false
    this.gen++
    const t0 = performance.now()
    this.token = randomBytes(24).toString('hex')
    this.stderr = new TailBuffer(8 * 1024)
    const child = spawn(this.opts.denoBin ?? 'deno', buildHostArgs(this.opts.memoryMb), {
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr.setEncoding('utf8').on('data', (c: string) => this.stderr.push(c))
    child.stdin.on('error', () => {})
    // spawn lỗi (thiếu deno / EXTENSIONS_DENO_BIN sai → ENOENT) phát 'error' — không bắt thì thành uncaughtException sập cả CRM.
    child.on('error', (e) => this.stderr.push(`spawn: ${e.message}\n`))
    child.stdin.write(`${this.token}\n`) // KHÔNG end(): stdin đóng = host tự thoát
    child.on('exit', () => void this.onExit(child))
    try {
      this.port = await readyPort(child, 10_000)
    } catch (e) {
      this.state = 'failed'
      child.kill('SIGKILL')
      throw e
    }
    this.readyReported = true
    const limit = this.opts.rssLimitMb ?? this.opts.memoryMb + 192
    const gen = this.gen
    this.stopWatch = child.pid
      ? watchRss(
          child.pid,
          limit,
          () => {},
          () => {
            this.rssKilledGens.add(gen)
            child.kill('SIGKILL')
          },
        )
      : () => {}
    for (const spec of this.specs.values()) await this.post('/load', spec, 10_000)
    if (child !== this.child || child.exitCode !== null || child.signalCode !== null)
      throw new Error('ext-host chết khi đang nạp lại')
    this.state = 'up' // chỉ "up" sau khi mọi chương trình con đã nạp lại — gọi sớm hơn sẽ gặp UnknownExt
    this.spawnToReadyMs.push(performance.now() - t0)
  }

  private async onExit(child: ChildProcess): Promise<void> {
    if (child !== this.child) return
    this.stopWatch()
    const release = this.recovered // người đang chờ dựng lại (nếu chính ta kill vì quá giờ)
    this.recovering = undefined
    this.recovered = undefined
    if (this.state === 'stopped') return release?.()
    const gotReady = this.readyReported
    this.state = 'stopped'
    if (!this.killedGens.has(this.gen)) this.opts.onCrash?.({ stderrTail: this.stderr.toString() })
    try {
      await this.starting?.catch(() => undefined) // một lần start() đang chạy dở trên tiến trình vừa chết
      if (!gotReady || this.restarts >= (this.opts.maxRestarts ?? 5)) throw new Error('bỏ cuộc')
      this.restarts++
      await this.ensureUp()
      this.restarts = 0
    } catch {
      this.state = 'failed'
    } finally {
      release?.()
    }
  }

  private waitClosed(ms: number): Promise<void> {
    const c = this.child
    if (!c || c.exitCode !== null || c.signalCode !== null)
      return new Promise((ok) => setTimeout(ok, 30))
    return new Promise((ok) => {
      const t = setTimeout(ok, ms)
      c.once('close', () => (clearTimeout(t), ok()))
    })
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<CallResult> {
    const gen = this.gen
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { ok: true, value: await res.json() }
    } catch (e) {
      return await this.failure(e, gen)
    }
  }

  private async failure(e: unknown, gen: number): Promise<CallResult> {
    if (e instanceof Error && e.name === 'TimeoutError') {
      this.killedGens.add(gen)
      this.recovering ??= new Promise<void>((ok) => (this.recovered = ok))
      this.child?.kill('SIGKILL')
      return { ok: false, kind: 'timeout', message: `quá giờ — ext-host bị kill và sẽ dựng lại` }
    }
    const byTimeout = this.killedGens.has(gen)
    const errBuf = this.stderr // bản của đúng đời tiến trình này (đời sau sẽ thay `this.stderr`)
    const byRss = this.rssKilledGens.has(gen)
    if (!byTimeout) await this.waitClosed(1000) // chờ stderr đổ nốt để thông báo có nguyên nhân (vd "out of memory")
    return {
      ok: false,
      kind: byTimeout ? 'host_restarted' : 'host_crashed',
      message: byTimeout
        ? 'ext-host bị dựng lại vì chương trình con khác quá giờ'
        : byRss
          ? `ext-host bị kill vì RSS vượt trần ${this.opts.rssLimitMb ?? this.opts.memoryMb + 192} MB (bộ nhớ ngoài heap)`
          : `ext-host chết: ${summarizeCrash(errBuf.toString())}`,
    }
  }
}

function readyPort(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ext-host không báo READY')), timeoutMs)
    let buf = ''
    child.stdout?.setEncoding('utf8').on('data', (c: string) => {
      buf += c
      const m = /READY (\d+)/.exec(buf)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('ext-host thoát trước khi READY'))
    })
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`ext-host không khởi động được: ${e.message}`))
    })
  })
}
