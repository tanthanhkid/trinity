// tsc đặt output theo rootDir `../..` ⇒ entry thật nằm ở dist/apps/monolith/src/serverless.js.
// Hợp đồng là `apps/monolith/dist/serverless.js` — viết shim 1 dòng trỏ vào bản thật.
const fs = require('node:fs')
const path = require('node:path')
const real = path.join(__dirname, '..', 'dist', 'apps', 'monolith', 'src', 'serverless.js')
if (!fs.existsSync(real)) {
  console.error(`Không thấy ${real} — tsc chưa biên dịch src/serverless.ts`)
  process.exit(1)
}
fs.writeFileSync(
  path.join(__dirname, '..', 'dist', 'serverless.js'),
  "module.exports = require('./apps/monolith/src/serverless')\n",
)
