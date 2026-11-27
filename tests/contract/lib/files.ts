import { config } from './config.js'
import { recordCall } from './coverage.js'

/** Kết quả tải/gửi tệp: thân là byte thô (xlsx, pdf, ảnh) chứ không phải chuỗi đã parse như `call()`. */
export interface RawRes {
  status: number
  headers: Headers
  bytes: Buffer
  /** JSON đã parse nếu thân là JSON (lỗi), ngược lại `null`. */
  json: unknown
}

export interface RawOpts {
  token?: string
  ip?: string
  /** Gửi multipart: mỗi phần tử là trường chữ hoặc tệp. */
  multipart?: { fields?: Record<string, string>; file?: { field: string; name: string; type: string; bytes: Uint8Array } }
  query?: Record<string, string>
}

export async function rawCall(method: string, path: string, opts: RawOpts = {}): Promise<RawRes> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.ip) headers['x-real-ip'] = opts.ip
  let body: FormData | undefined
  if (opts.multipart) {
    body = new FormData()
    for (const [k, v] of Object.entries(opts.multipart.fields ?? {})) body.append(k, v)
    const f = opts.multipart.file
    if (f) body.append(f.field, new Blob([f.bytes as BlobPart], { type: f.type }), f.name)
  }
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const res = await fetch(`${config.baseUrl}${path}${qs}`, { method, headers, body, redirect: 'manual' })
  recordCall(method, path, res.status, Boolean(opts.token))
  const bytes = Buffer.from(await res.arrayBuffer())
  let json: unknown = null
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      json = JSON.parse(bytes.toString('utf8'))
    } catch {
      /* không phải JSON */
    }
  }
  return { status: res.status, headers: res.headers, bytes, json }
}

/** PNG 1×1 hợp lệ (ảnh selfie, tệp thử). */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
/** PDF tối thiểu (tệp hợp đồng thử). */
export const PDF_MIN = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
