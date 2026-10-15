import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

/**
 * RSS (KB) của một pid. Linux: đọc /proc/<pid>/statm (không fork — đủ rẻ để poll mỗi 20 ms trên máy ít CPU);
 * macOS: `ps -o rss=`. null nếu tiến trình đã mất.
 */
export async function rssKb(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      const pages = Number((await readFile(`/proc/${pid}/statm`, 'utf8')).split(' ')[1])
      return Number.isNaN(pages) ? null : pages * 4 // trang 4 KB (x86_64/arm64 phổ biến)
    } catch {
      return null
    }
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], (err, out) => {
      const n = Number.parseInt(out.trim(), 10)
      resolve(err || Number.isNaN(n) ? null : n)
    })
  })
}

/**
 * Canh RSS: `--max-old-space-size` CHỈ chặn heap V8, KHÔNG chặn bộ nhớ ngoài heap (ArrayBuffer/Uint8Array, wasm) —
 * đã đo: job với trần 64 MB cấp được >1 GB bằng Uint8Array. Nên supervisor tự poll RSS và SIGKILL khi vượt trần.
 * Trên Linux thật nên thêm cgroup (systemd MemoryMax) làm lưới cuối; poll 20 ms vẫn để lọt một cú cấp phát cực nhanh.
 */
export function watchRss(
  pid: number,
  limitMb: number,
  onSample: (kb: number) => void,
  onExceed: () => void,
): () => void {
  let done = false
  const timer = setInterval(async () => {
    const r = await rssKb(pid)
    if (done || r === null) return
    onSample(r)
    if (r > limitMb * 1024) {
      done = true
      onExceed()
    }
  }, 20)
  return () => {
    done = true
    clearInterval(timer)
  }
}

/** Giữ `head` ký tự ĐẦU và `max` ký tự CUỐI của luồng (log tiến trình con có thể vô hạn; nguyên nhân thường nằm ở đầu). */
export class TailBuffer {
  private headText = ''
  private text = ''
  private cut = false
  private readonly max: number
  private readonly head: number
  constructor(max: number, head = 2048) {
    this.max = max
    this.head = head
  }
  push(chunk: string): void {
    if (this.headText.length < this.head) {
      const take = chunk.slice(0, this.head - this.headText.length)
      this.headText += take
      chunk = chunk.slice(take.length)
    }
    this.text += chunk
    if (this.text.length > this.max) {
      this.text = this.text.slice(-this.max)
      this.cut = true
    }
  }
  toString(): string {
    return this.headText + (this.cut ? '\n…\n' : '') + this.text
  }
}

/** Tóm tắt nguyên nhân chết của một tiến trình Deno từ stderr: V8 hết heap in ra cả stack dài nên tìm riêng. */
export function summarizeCrash(stderr: string): string {
  if (/out of memory|Allocation failed|heap limit/i.test(stderr))
    return 'hết bộ nhớ (Fatal JavaScript out of memory)'
  return stderr.trim().slice(-300) || 'không có stderr'
}
