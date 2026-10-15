/**
 * Sau `next build` (serverless): nối phụ thuộc của Nest vào danh sách file của hàm `/api/v1/*`.
 *
 * Next/Vercel đóng gói mỗi hàm theo `.next/server/**.nft.json`. Nest nạp bằng `require` đường dẫn động (`lib/nest-bridge.ts`)
 * nên Next không vết được; ta vết bằng `@vercel/nft` (cùng thư viện Next dùng) từ entry thật rồi nối vào nft.json của route.
 *
 * Dùng: `node scripts/append-monolith-trace.cjs [--report]`. In kích thước hàm (MB, đã khử trùng, theo realpath).
 */
const fs = require('node:fs')
const path = require('node:path')

const WEB = path.resolve(__dirname, '..')
const ROOT = path.resolve(WEB, '../..') // trinity/
const NFT_JSON = path.join(WEB, '.next/server/app/api/v1/[...path]/route.js.nft.json')
const ENTRY = path.join(ROOT, 'apps/monolith/dist/apps/monolith/src/serverless.js')
/** Shim `dist/serverless.js` (do `write-serverless-shim.cjs` sinh) là file `lib/nest-bridge.ts` tìm ở runtime — PHẢI nằm trong hàm. */
const SHIM = path.join(ROOT, 'apps/monolith/dist/serverless.js')
const LIMIT_MB = 250

/** Bỏ thứ không cần ở runtime Vercel (linux x64, Prisma library engine). */
function keep(rel) {
  if (/\.(map|d\.ts|d\.mts|md|markdown)$/i.test(rel)) return false
  if (/\/node_modules\/prisma\//.test(rel) || /\/@prisma\/engines\//.test(rel)) return false // CLI + schema-engine: chỉ cần lúc migrate
  if (/\.prisma\/client\//.test(rel)) {
    if (/\.wasm$|query_engine_bg|\/(edge|wasm|react-native|default|index-browser)\.(js|mjs)$/.test(rel)) return false
    if (/libquery_engine-/.test(rel) && !/rhel-openssl-3\.0\.x/.test(rel) && !isHostEngine(rel)) return false
  }
  return true
}
function isHostEngine(rel) {
  // Build local (mac/linux dev) cần engine máy mình để chạy thử; Vercel build chạy trên rhel nên chỉ còn rhel.
  const host = `${process.platform}-${process.arch}`
  return process.env.TRINITY_TRACE_HOST_ENGINE === '1' && rel.includes(process.platform === 'darwin' ? 'darwin' : host)
}

async function main() {
  const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft')
  if (!fs.existsSync(ENTRY)) throw new Error(`Thiếu ${ENTRY} — chạy "pnpm --filter @trinity/monolith build" trước.`)
  if (!fs.existsSync(SHIM)) throw new Error(`Thiếu ${SHIM} — build monolith phải chạy write-serverless-shim.cjs.`)
  if (!fs.existsSync(NFT_JSON)) throw new Error(`Thiếu ${NFT_JSON} — chạy "next build" với TRINITY_RUNTIME=serverless trước.`)

  const { fileList } = await nodeFileTrace([SHIM, ENTRY], { base: ROOT, processCwd: ROOT, mixedModules: true })
  const extra = new Set(fileList)
  // Prisma: engine nhị phân được nạp theo đường dẫn ghép — nft có thể sót; thêm cả thư mục `.prisma/client` (đã lọc ở `keep`).
  const store = path.join(ROOT, 'node_modules/.pnpm')
  for (const d of fs.readdirSync(store).filter((n) => n.startsWith('@prisma+client@'))) {
    const dir = path.join(store, d, 'node_modules/.prisma/client')
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) extra.add(path.relative(ROOT, path.join(dir, f)))
  }
  // sharp nạp binary nền tảng bằng tên ghép động.
  for (const d of fs.readdirSync(store).filter((n) => n.startsWith('@img+'))) {
    walk(path.join(store, d), (f) => extra.add(path.relative(ROOT, f)))
  }

  const nftDir = path.dirname(NFT_JSON)
  const json = JSON.parse(fs.readFileSync(NFT_JSON, 'utf8'))
  const files = new Set(json.files)
  for (const rel of extra) {
    if (!keep(rel)) continue
    const abs = path.join(ROOT, rel)
    let st
    try { st = fs.statSync(abs) } catch { continue }
    if (!st.isFile()) continue
    files.add(path.relative(nftDir, abs).split(path.sep).join('/'))
  }
  json.files = [...files].sort()
  fs.writeFileSync(NFT_JSON, JSON.stringify(json))

  let total = 0
  const seen = new Set()
  for (const f of json.files) {
    let real
    try { real = fs.realpathSync(path.join(nftDir, f)) } catch { continue }
    if (seen.has(real) || !fs.statSync(real).isFile()) continue
    seen.add(real)
    total += fs.statSync(real).size
  }
  const mb = total / 1e6
  console.log(`[append-monolith-trace] hàm /api/v1/*: ${json.files.length} mục, ~${mb.toFixed(1)} MB (giới hạn Vercel Hobby ${LIMIT_MB} MB, chưa nén)`)
  if (mb > LIMIT_MB) { console.error('VƯỢT giới hạn bundle hàm'); process.exit(1) }
}

function walk(dir, cb) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, cb)
    else cb(p)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
