#!/usr/bin/env node
// Sinh dữ liệu đối chiếu cho tests/node_compat.rs bằng CHÍNH mã Node của repo:
//  1. `LocalDiskStorageDriver` và `createUploadsStore` của packages/storage (bản build dist/) ghi file vào
//     tests/fixtures/node-written/{storage,uploads}.
//  2. `express.static` đúng phiên bản monolith dùng (Nest platform-express → express 4 → serve-static → send) phục vụ
//     thư mục uploads đó; ghi status + Content-Type (fetch đi theo chuyển hướng như route Next) vào
//     tests/fixtures/node-uploads-golden.json.
// Chạy ở gốc repo: pnpm install --frozen-lockfile && pnpm --filter @trinity/storage build &&
//   node server/crates/trinity-storage/scripts/gen-node-fixture.cjs
const path = require('node:path')
const fs = require('node:fs')
const root = path.resolve(__dirname, '../../../..')
const fixtures = path.resolve(__dirname, '../tests/fixtures')
const storage = require(path.join(root, 'packages/storage/dist'))

const pe = require.resolve('@nestjs/platform-express', { paths: [path.join(root, 'apps/monolith')] })
const express = require(require.resolve('express', { paths: [pe] }))

async function main() {
  const out = path.join(fixtures, 'node-written')
  fs.rmSync(out, { recursive: true, force: true })

  const driver = new storage.LocalDiskStorageDriver(path.join(out, 'storage'))
  await driver.init()
  await driver.upload('documents/0912345678/attachments/1_front.jpg', Buffer.from('hello world'), 'image/jpeg')
  await driver.upload('documents/hồ sơ (1).pdf', Buffer.from('%PDF-1.4 fake'), 'application/pdf')
  await driver.upload('voice/2026-09-27/abc', Buffer.from('0123456789'), 'audio/mpeg')
  await driver.upload('notes/1/..report.jpg', Buffer.from('dots'), 'image/jpeg')
  await driver.upload('a/quote.txt', Buffer.from('q'), 'text/plain; charset="utf-8"\né')
  await driver.upload('a/empty.bin', Buffer.alloc(0), 'application/octet-stream')

  const uploadsRoot = path.join(out, 'uploads')
  const store = storage.createUploadsStore({ localRoot: uploadsRoot })
  await store.save('avatars/1_123.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg')
  await store.save('c2/products/1700000000000_abcdef012345.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]), 'image/png')
  await store.save('products/a b.webp', Buffer.from('RIFFxxxxWEBP'), 'image/webp')
  await store.save('products/x.gif', Buffer.from('GIF89a'), 'image/gif')
  await store.save('products/X.JPG', Buffer.from('upper'), 'image/jpeg')
  await store.save('docs/readme.txt', Buffer.from('xin chào'), 'text/plain')
  await store.save('docs/noext', Buffer.from('n'), 'x')
  await store.save('docs/.secret', Buffer.from('s'), 'x')
  await store.save('.hidden/ok.jpg', Buffer.from('h'), 'image/jpeg')
  await store.save('site/index.html', Buffer.from('<p>i</p>'), 'text/html')
  await store.save('emptydir/.keep', Buffer.from(''), 'x')

  // Đường dẫn gửi tới monolith như route Next: các segment đã giải mã, mã hoá lại bằng encodeURIComponent.
  const cases = [
    ['avatars', '1_123.jpg'],
    ['c2', 'products', '1700000000000_abcdef012345.png'],
    ['products', 'a b.webp'],
    ['products', 'x.gif'],
    ['products', 'X.JPG'],
    ['docs', 'readme.txt'],
    ['docs', 'noext'],
    ['docs', '.secret'],
    ['.hidden', 'ok.jpg'],
    ['site'],
    ['emptydir'],
    ['avatars', 'none.jpg'],
    ['avatars', '1_123.jpg', 'x'],
    ['avatars', 'a\0b.jpg'],
    ['x'.repeat(300) + '.jpg'],
  ]
  const app = express()
  app.use('/uploads', express.static(uploadsRoot))
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const golden = []
  for (const segs of cases) {
    const res = await fetch(`${base}/uploads/${segs.map(encodeURIComponent).join('/')}`)
    const body = Buffer.from(await res.arrayBuffer())
    golden.push({
      segments: segs,
      status: res.status,
      content_type: res.ok ? res.headers.get('content-type') : null,
      body_hex: res.ok ? body.toString('hex') : null,
    })
  }
  server.close()
  fs.writeFileSync(path.join(fixtures, 'node-uploads-golden.json'), JSON.stringify(golden, null, 2) + '\n')
}

main().catch((e) => { console.error(e); process.exit(1) })
