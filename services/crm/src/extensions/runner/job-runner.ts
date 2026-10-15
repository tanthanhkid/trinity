import { spawn } from 'node:child_process'
import type { Limits, JobResult, JobOutcome } from './types'
import { buildJobArgs, cleanEnv } from './deno-args'
import { TailBuffer, watchRss } from './proc'

export interface JobRunOptions {
  denoBin?: string
  code: string
  net: string[]
  limits: Limits
  params?: unknown
  /** 'job' gọi `default(ctx)`; 'tool'/'api' gọi tool `tool` với `args`. */
  kind?: 'job' | 'tool' | 'api'
  tool?: string
  args?: unknown
  inputSchema?: Record<string, unknown>
  dryRun?: boolean
  gateway?: { url: string; token: string }
  /** Trần RSS toàn tiến trình (MB) — canh bằng poll vì V8 không chặn bộ nhớ ngoài heap. Mặc định memoryMb + 100. */
  rssLimitMb?: number
}

const READY = '__EXT_READY__'
const RESULT = '__EXT_RESULT__ '

function classify(
  code: number | null,
  timedOut: boolean,
  rssKilled: boolean,
  stderr: string,
): JobOutcome {
  if (timedOut) return 'timeout'
  if (rssKilled) return 'oom'
  if (code === 0) return 'ok'
  if (/out of memory|Allocation failed|heap limit/i.test(stderr) || code === 133) return 'oom'
  if (/NotCapable|PermissionDenied|Requires \w+ access/.test(stderr)) return 'permission_denied'
  return 'error'
}

function parseResult(stdout: string): unknown {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(RESULT))
  if (!line) return null
  try {
    return JSON.parse(line.slice(RESULT.length))
  } catch {
    return null
  }
}

/** Sinh MỘT tiến trình Deno cho một lần chạy job, khoá quyền, kill khi quá giờ. Không bao giờ ném — luôn trả JobResult. */
export function runJob(o: JobRunOptions): Promise<JobResult> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const child = spawn(o.denoBin ?? 'deno', buildJobArgs(o.net, o.limits.memoryMb), {
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = new TailBuffer(64 * 1024)
    const err = new TailBuffer(16 * 1024)
    let startupMs: number | null = null
    let timedOut = false
    let rssKilled = false
    let peak: number | null = null
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      if (startupMs === null && c.includes(READY)) startupMs = performance.now() - t0
      out.push(c)
    })
    child.stderr.setEncoding('utf8').on('data', (c: string) => err.push(c))
    child.stdin.on('error', () => {}) // tiến trình chết sớm → EPIPE, không phải lỗi của supervisor
    child.stdin.end(
      JSON.stringify({
        kind: o.kind ?? 'job',
        code: o.code,
        params: o.params ?? null,
        gateway: o.gateway,
        dryRun: o.dryRun === true,
        tool: o.tool,
        args: o.args,
        inputSchema: o.inputSchema,
      }),
    )
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, o.limits.timeoutMs)
    const stopWatch = child.pid
      ? watchRss(
          child.pid,
          o.rssLimitMb ?? o.limits.memoryMb + 100,
          (kb) => (peak = Math.max(peak ?? 0, kb)),
          () => {
            rssKilled = true
            child.kill('SIGKILL')
          },
        )
      : () => {}
    child.on('error', (e) => err.push(`spawn: ${e.message}`))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      stopWatch()
      const stderr = err.toString()
      resolve({
        outcome: classify(code, timedOut, rssKilled, stderr),
        exitCode: code,
        signal,
        durationMs: performance.now() - t0,
        startupMs,
        peakRssKb: peak,
        stdout: out.toString(),
        stderr,
        result: parseResult(out.toString()),
      })
    })
  })
}
