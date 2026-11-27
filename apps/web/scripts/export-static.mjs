/**
 * Luật phục vụ bản xuất tĩnh (R004, phương án A) — dùng chung cho build-export.mjs, serve-export.mjs, check-export.mjs.
 *
 * Mỗi route động được xuất MỘT trang giữ chỗ, mọi đoạn động là `_` (`out/contacts/_.html`, `out/x/_/v/_.html`). Phục vụ:
 * thay MỌI đoạn động trong đường dẫn bằng `_` rồi tìm tệp, gồm cả yêu cầu payload (`/contacts/123/__next._tree.txt`,
 * `__next.*.txt`) và HEAD của prefetch. Bảng luật sinh từ tên tệp trong `out/`, không viết tay. Đoạn bắt đầu bằng `__next`
 * là tên tệp payload của Next, không phải giá trị tham số. K18 (Rust) làm đúng thuật toán này.
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative, sep, extname } from 'node:path'

export const PLACEHOLDER = '_'

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else yield p
  }
}

/** Mọi `.html` có đoạn `_` ⇒ một luật `{ pattern: 'x/_/v/_', segments: [...], literals }`, xếp cụ thể nhất (nhiều đoạn chữ) trước. */
export function buildRules(outDir) {
  const seen = new Set()
  for (const f of walk(outDir)) {
    if (!f.endsWith('.html')) continue
    const segs = relative(outDir, f).split(sep).join('/').replace(/\.html$/, '').split('/')
    if (segs.includes(PLACEHOLDER)) seen.add(segs.join('/'))
  }
  return [...seen]
    .map((pattern) => {
      const segments = pattern.split('/')
      return { pattern, segments, literals: segments.filter((s) => s !== PLACEHOLDER).length }
    })
    .sort((a, b) => b.literals - a.literals || b.segments.length - a.segments.length || a.pattern.localeCompare(b.pattern))
}

const isFile = (p) => existsSync(p) && statSync(p).isFile()

/** Thử tệp tĩnh đúng tên: `/login` ⇒ `login.html`, `/` ⇒ `index.html`. */
export function findFile(outDir, urlPath) {
  const rel = urlPath.replace(/^\/+/, '').replace(/\/+$/, '')
  const cands = rel === '' ? ['index.html'] : [rel, `${rel}.html`, `${rel}/index.html`]
  for (const c of cands) {
    const fp = join(outDir, c)
    if (fp.startsWith(outDir) && isFile(fp)) return fp
  }
  return null
}

/**
 * Tìm tệp cho một đường dẫn yêu cầu: tệp đúng tên trước (vd `/contacts/new`), rồi tới các luật theo thứ tự cụ thể.
 * Trả `{ file, placeholderRule }` hoặc `null`.
 */
export function resolvePath(outDir, rules, urlPath) {
  const exact = findFile(outDir, urlPath)
  if (exact) return { file: exact, rule: null }
  const segs = urlPath.split('/').filter(Boolean)
  for (const rule of rules) {
    const n = rule.segments.length
    if (segs.length < n) continue
    let ok = true
    for (let i = 0; i < n && ok; i++) {
      ok = rule.segments[i] === PLACEHOLDER ? !segs[i].startsWith('__next') : rule.segments[i] === segs[i]
    }
    if (!ok) continue
    const mapped = '/' + [...rule.segments, ...segs.slice(n)].join('/')
    const file = findFile(outDir, mapped)
    if (file) return { file, rule: rule.pattern }
  }
  return null
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/x-component; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}
export const mimeOf = (file) => MIME[extname(file)] ?? 'application/octet-stream'

export const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * Chèn giá trị lúc phục vụ HTML (đúng việc K18 phải làm cho Rust):
 *  - `slug` (tên miền phụ cửa hàng): `<meta name="store-slug" content="…">`.
 *  - `legal` (đường `/privacy`, `/terms`): thay `__LEGAL_COMPANY_NAME__`, `__LEGAL_CONTACT__` và thêm
 *    `<meta name="trinity-legal" content='JSON'>` (xem src/components/legal-page-export.tsx).
 */
export function injectHtml(html, { slug, legal } = {}) {
  let out = html
  const metas = []
  if (slug) metas.push(`<meta name="store-slug" content="${escapeHtml(slug)}"/>`)
  if (legal) {
    metas.push(`<meta name="trinity-legal" content="${escapeHtml(JSON.stringify(legal))}"/>`)
    out = out
      .replaceAll('__LEGAL_COMPANY_NAME__', escapeHtml(legal.company_name ?? ''))
      .replaceAll('__LEGAL_CONTACT__', escapeHtml(legal.contact_email ?? 'quản trị viên của hệ thống Trinity bạn đang dùng'))
  }
  if (metas.length) out = out.replace('</head>', `${metas.join('')}</head>`)
  return out
}

/** Giá trị pháp lý từ biến môi trường `LEGAL_*` (cùng tên với bản cài thật). */
export function legalFromEnv(env = process.env) {
  const v = (k) => env[k]?.trim() || null
  return {
    contact_email: v('LEGAL_CONTACT_EMAIL'),
    company_name: v('LEGAL_COMPANY_NAME'),
    company_name_en: v('LEGAL_COMPANY_NAME_EN'),
    company_tax_id: v('LEGAL_COMPANY_TAX_ID'),
    company_address: v('LEGAL_COMPANY_ADDRESS'),
    company_phone: v('LEGAL_COMPANY_PHONE'),
  }
}

export const readText = (f) => readFileSync(f, 'utf8')
