/**
 * Tải video lên theo phần (X15a): proxy Cloudflare cắt body ở 100 MB nên video lớn đi thành các phần do máy chủ ấn định cỡ
 * (`part_size`, ≤ 50 MB), ghép ở máy chủ. Logic thuần, không biết axios: gọi mạng qua `ChunkTransport` để test được.
 *
 * - Tiếp tục khi rớt mạng: mỗi phần thử lại tối đa `retries` lần (chờ tăng dần); `upload_id` nhớ theo tệp
 *   (`tên:cỡ:lastModified`) trong `storage`, mở lại trang rồi chọn đúng tệp đó thì hỏi máy chủ phần nào đã có và chỉ gửi phần thiếu.
 * - Huỷ (`AbortSignal`): xoá phiên trên máy chủ (không để lại phần rác) và quên `upload_id`.
 * - Lỗi 4xx (trừ 408/429) là lỗi thật, không thử lại.
 */

/** Dưới ngưỡng này video vẫn đi một lần qua `POST /social/media` (đã dưới giới hạn 100 MB của proxy). */
export const CHUNKED_VIDEO_THRESHOLD = 90 * 1024 * 1024

export interface ChunkSession {
  upload_id: string
  part_size: number
  total_parts: number
}

export interface ChunkStatus extends Omit<ChunkSession, "upload_id"> {
  received: number[]
}

export interface ChunkTransport<T> {
  init(body: { file_name: string; size: number }): Promise<ChunkSession>
  /** `null` khi phiên không còn (404). */
  status(uploadId: string): Promise<ChunkStatus | null>
  putPart(uploadId: string, index: number, part: Blob, onSent: (bytes: number) => void, signal?: AbortSignal): Promise<void>
  complete(uploadId: string): Promise<T>
  cancel(uploadId: string): Promise<void>
}

export type ChunkStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export interface ChunkUploadOptions {
  onProgress?: (pct: number) => void
  signal?: AbortSignal
  storage?: ChunkStorage | null
  retries?: number
  /** Chờ trước lần thử lại thứ `attempt` (1..); test truyền hàm không chờ. */
  wait?: (ms: number) => Promise<void>
}

const STORE_PREFIX = "trinity:social-chunk:"

export function resumeKey(file: Pick<File, "name" | "size" | "lastModified">): string {
  return `${STORE_PREFIX}${file.name}:${file.size}:${file.lastModified}`
}

function safe<R>(fn: () => R): R | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/** Lỗi có `response.status` (axios) hoặc `status`; không có ⇒ lỗi mạng (đáng thử lại). */
export function isFatalChunkError(err: unknown): boolean {
  const e = err as { response?: { status?: number }; status?: number } | null
  const s = e?.response?.status ?? e?.status
  return typeof s === "number" && s >= 400 && s < 500 && s !== 408 && s !== 429
}

export class ChunkAborted extends Error {
  constructor() {
    super("Đã huỷ tải lên")
    this.name = "ChunkAborted"
  }
}

const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function uploadVideoInChunks<T>(
  file: File,
  transport: ChunkTransport<T>,
  opts: ChunkUploadOptions = {},
): Promise<T> {
  const { onProgress, signal, retries = 4 } = opts
  const wait = opts.wait ?? defaultWait
  const storage = opts.storage === undefined ? safe(() => window.localStorage) : opts.storage
  const rkey = resumeKey(file)
  const forget = () => safe(() => storage?.removeItem(rkey))

  // Phiên cũ của đúng tệp này còn sống ⇒ tiếp tục; không thì khai phiên mới.
  let session: ChunkSession | null = null
  let have = new Set<number>()
  const saved = safe(() => storage?.getItem(rkey)) ?? null
  if (saved) {
    const st = await transport.status(saved).catch(() => null)
    if (st && st.total_parts === Math.ceil(file.size / st.part_size)) {
      session = { upload_id: saved, part_size: st.part_size, total_parts: st.total_parts }
      have = new Set(st.received)
    } else {
      forget()
    }
  }
  if (!session) {
    session = await transport.init({ file_name: file.name, size: file.size })
    safe(() => storage?.setItem(rkey, session!.upload_id))
  }
  const { upload_id: id, part_size: size, total_parts: total } = session

  let sent = 0
  for (const i of have) sent += Math.min(size, file.size - i * size)
  const report = () => onProgress?.(Math.min(99, Math.floor((sent / file.size) * 100)))
  report()

  const cancel = async () => {
    forget()
    await transport.cancel(id).catch(() => undefined)
  }
  try {
    for (let i = 0; i < total; i++) {
      if (have.has(i)) continue
      const part = file.slice(i * size, Math.min(file.size, (i + 1) * size))
      const base = sent
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new ChunkAborted()
        try {
          await transport.putPart(id, i, part, (b) => {
            sent = base + b
            report()
          }, signal)
          sent = base + part.size
          report()
          break
        } catch (err) {
          sent = base
          if (signal?.aborted) throw new ChunkAborted()
          if (isFatalChunkError(err) || attempt >= retries) throw err
          await wait(Math.min(8000, 500 * 2 ** attempt))
        }
      }
    }
    if (signal?.aborted) throw new ChunkAborted()
    const res = await transport.complete(id)
    forget()
    onProgress?.(100)
    return res
  } catch (err) {
    if (err instanceof ChunkAborted) {
      await cancel()
    } else if (isFatalChunkError(err)) {
      // Phiên hỏng hẳn (hết hạn, tệp sai cỡ…): xoá phần rác, lần sau khai lại từ đầu.
      await cancel()
    }
    // Lỗi mạng còn lại: giữ phiên để chọn lại đúng tệp rồi tiếp tục.
    throw err
  }
}
