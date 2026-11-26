#!/usr/bin/env node
// Sinh src/mime_db.rs từ đúng gói `mime` mà /uploads của bản Node dùng (Nest platform-express → express 4 →
// serve-static → send → mime 1.6). Chạy ở gốc repo sau `pnpm install`:
//   node server/crates/trinity-storage/scripts/gen-mime.cjs > server/crates/trinity-storage/src/mime_db.rs
const path = require('node:path')
const root = path.resolve(__dirname, '../../../..')
const pe = require.resolve('@nestjs/platform-express', { paths: [path.join(root, 'apps/monolith')] })
const ex = require.resolve('express', { paths: [pe] })
const ss = require.resolve('serve-static', { paths: [ex] })
const sd = require.resolve('send', { paths: [ss] })
const mm = require.resolve('mime', { paths: [sd] })
const mime = require(mm)
const version = require(path.join(path.dirname(mm), 'package.json')).version
const exts = Object.keys(mime.types).sort()
const out = []
out.push(`// @generated bởi scripts/gen-mime.cjs từ mime ${version} (gói send ${require(path.join(path.dirname(sd), 'package.json')).version} dùng). Không sửa tay.`)
out.push('')
out.push('/// (phần mở rộng chữ thường, kiểu MIME), sắp theo phần mở rộng để tìm nhị phân.')
out.push('#[rustfmt::skip]')
out.push(`pub(crate) static TYPES: [(&str, &str); ${exts.length}] = [`)
for (const e of exts) out.push(`    (${JSON.stringify(e)}, ${JSON.stringify(mime.types[e])}),`)
out.push('];')
process.stdout.write(out.join('\n') + '\n')
