import net from 'node:net'

/**
 * SMTP giả cho e2e (#675): nghe 127.0.0.1:<port>, nói đủ EHLO/MAIL/RCPT/DATA/QUIT (không TLS, không AUTH), giữ nguyên văn
 * thư. Máy chủ Rust gửi tới đây khi chạy với `SMTP_HOST=127.0.0.1 SMTP_SECURITY=none` — không thư nào ra ngoài.
 */
export interface Received {
  to: string[]
  raw: string
}

export class FakeSmtp {
  private server: net.Server
  private sockets = new Set<net.Socket>()
  readonly inbox: Received[] = []

  constructor(readonly port: number) {
    this.server = net.createServer((sock) => {
      this.sockets.add(sock)
      sock.on('close', () => this.sockets.delete(sock))
      this.session(sock)
    })
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => resolve())
    })
  }

  /** Máy chủ giữ kết nối SMTP trong pool: đóng hẳn mọi socket, nếu không `close()` chờ mãi. */
  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  /** Chờ thư thứ `n` (đếm từ 1) gửi tới `to`. */
  async waitFor(to: string, n = 1, timeoutMs = 15_000): Promise<Received> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      const got = this.inbox.filter((m) => m.to.some((t) => t.toLowerCase() === to.toLowerCase()))
      if (got.length >= n) return got[n - 1]
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`không có thư thứ ${n} tới ${to}`)
  }

  count(to: string): number {
    return this.inbox.filter((m) => m.to.some((t) => t.toLowerCase() === to.toLowerCase())).length
  }

  private session(sock: net.Socket) {
    let buf = ''
    let inData = false
    let data = ''
    let to: string[] = []
    sock.write('220 fake-smtp ESMTP\r\n')
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            this.inbox.push({ to, raw: data })
            data = ''
            sock.write('250 queued\r\n')
          } else {
            data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n'
          }
          continue
        }
        const up = line.toUpperCase()
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-fake-smtp\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n')
        else if (up.startsWith('MAIL FROM:')) {
          to = []
          sock.write('250 OK\r\n')
        } else if (up.startsWith('RCPT TO:')) {
          to.push(line.slice(8).trim().replace(/^<|>$/g, ''))
          sock.write('250 OK\r\n')
        } else if (up === 'DATA') {
          inData = true
          sock.write('354 go\r\n')
        } else if (up === 'QUIT') {
          sock.end('221 bye\r\n')
        } else sock.write('250 OK\r\n')
      }
    })
    sock.on('error', () => {})
  }
}

/** Bản chữ đã giải mã quoted-printable / base64 của mọi phần MIME. */
export function decodedText(raw: string): string {
  const out: string[] = []
  for (const part of raw.split(/\r\n--/)) {
    const sep = part.indexOf('\r\n\r\n')
    if (sep < 0) continue
    const head = part.slice(0, sep).toLowerCase()
    const body = part.slice(sep + 4)
    if (head.includes('content-transfer-encoding: base64')) out.push(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'))
    else if (head.includes('content-transfer-encoding: quoted-printable')) {
      const soft = body.replace(/=\r\n/g, '')
      const bytes: number[] = []
      for (let i = 0; i < soft.length; i++) {
        if (soft[i] === '=' && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
          bytes.push(parseInt(soft.slice(i + 1, i + 3), 16))
          i += 2
        } else bytes.push(...Buffer.from(soft[i], 'utf8'))
      }
      out.push(Buffer.from(bytes).toString('utf8'))
    } else if (head.includes('content-type: text/')) out.push(body)
  }
  return out.join('\n')
}

export function codeOf(raw: string): string {
  const m = decodedText(raw).match(/Mã của bạn: (\d{6})/)
  if (!m) throw new Error('thư không có mã 6 số')
  return m[1]
}

export function linkOf(raw: string): string {
  const m = decodedText(raw).match(/(https?:\/\/\S+\/auth\/email#token=[A-Za-z0-9._-]+)/)
  if (!m) throw new Error('thư không có link đăng nhập')
  return m[1]
}
