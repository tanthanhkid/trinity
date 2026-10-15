export type ExtKind = 'job' | 'api' | 'tool'

/** Giới hạn tài nguyên của MỘT tiến trình Deno (job/chạy thử: mỗi lần; tool: cả ext-host). */
export interface Limits {
  timeoutMs: number
  memoryMb: number
}

export const DEFAULT_LIMITS: Limits = { timeoutMs: 15_000, memoryMb: 128 }
export const MAX_LIMITS: Limits = { timeoutMs: 600_000, memoryMb: 512 }

export type JobOutcome = 'ok' | 'error' | 'timeout' | 'oom' | 'permission_denied' | 'disabled'

export interface JobResult {
  outcome: JobOutcome
  exitCode: number | null
  signal: string | null
  durationMs: number
  /** Từ lúc spawn tới lúc job-main báo sẵn sàng (Deno khởi động). */
  startupMs: number | null
  peakRssKb: number | null
  stdout: string
  stderr: string
  /** Giá trị trả về (mã khách tự khai nên không tin được, chỉ để hiển thị). */
  result: unknown
}

export type CallErrorKind = 'tool_error' | 'timeout' | 'host_crashed' | 'host_restarted' | 'host_unavailable' | 'disabled' | 'unknown_tool'

export type CallResult = { ok: true; value: unknown } | { ok: false; kind: CallErrorKind; message: string }

export interface ToolMeta {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
