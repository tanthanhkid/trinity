import { inflateRawSync } from 'node:zlib'
import { Normalizer } from './normalize.js'
import type { RawRes } from './files.js'
import type { Snapshot } from './golden.js'

/**
 * Đọc .xlsx không cần thư viện (zip + XML): đủ để so NỘI DUNG THEO Ô giữa Node và Rust (C14d), không so byte của zip (chứa giờ ghi và
 * thứ tự do thư viện sinh). Hỗ trợ chuỗi dùng chung, chuỗi nội tuyến, số, boolean; công thức trả về giá trị đã lưu.
 */
export interface Sheet {
  name: string
  /** Hàng theo thứ tự; ô rỗng là `''`; cắt hàng và cột trống ở cuối. */
  rows: string[][]
}

function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('không phải tệp zip/xlsx')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const files = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('thư mục trung tâm zip hỏng')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    const lnlen = buf.readUInt16LE(off + 26)
    const lelen = buf.readUInt16LE(off + 28)
    const data = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize)
    files.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data))
    p += 46 + nlen + elen + clen
  }
  return files
}

const unxml = (s: string): string =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

const textOf = (xml: string): string => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('')

function colIndex(ref: string): number {
  let n = 0
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export function readXlsx(buf: Buffer): Sheet[] {
  const files = unzip(buf)
  const get = (name: string): string => files.get(name)?.toString('utf8') ?? ''
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/\bId="([^"]*)"/.exec(m[0])?.[1] ?? '', /\bTarget="([^"]*)"/.exec(m[0])?.[1] ?? '']))
  const sheets: Sheet[] = []
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? '')
    const rid = /\br:id="([^"]*)"/.exec(m[0])?.[1] ?? ''
    const target = (rels.get(rid) ?? '').replace(/^\/?(xl\/)?/, 'xl/')
    const xml = get(target)
    const rows: string[][] = []
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowIdx = Number(/\br="(\d+)"/.exec(r[0])?.[1] ?? rows.length + 1) - 1
      const cells: string[] = []
      for (const c of (r[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]
        const body = c[2] ?? ''
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? ''
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? 'n'
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
        let val = ''
        if (type === 's') val = shared[Number(v)] ?? ''
        else if (type === 'inlineStr') val = textOf(body)
        else if (v !== undefined) val = unxml(v)
        cells[colIndex(ref)] = val
      }
      for (let i = 0; i < cells.length; i++) cells[i] ??= ''
      while (rows.length < rowIdx) rows.push([])
      rows[rowIdx] = cells
    }
    while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop()
    sheets.push({ name, rows })
  }
  return sheets
}

/** Ảnh chụp để so/ghi golden: mã trạng thái, kiểu nội dung, và từng ô của từng bảng đã chuẩn hoá (id, mốc thời gian, email thử). */
export function snapXlsx(res: RawRes, normalizer = new Normalizer()): Snapshot {
  const sheets = res.status === 200 ? readXlsx(res.bytes) : []
  return {
    status: res.status,
    body: normalizer.normalize({
      content_type: (res.headers.get('content-type') ?? '').split(';')[0],
      disposition: /filename\*?=/.test(res.headers.get('content-disposition') ?? ''),
      sheets,
      ...(res.status === 200 ? {} : { error: res.json }),
    }),
  }
}
