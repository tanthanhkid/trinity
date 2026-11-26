#!/usr/bin/env node
// Sinh bản đóng băng schema `platform` cho tests/platform.rs bằng CHÍNH mã Node của repo (packages/prisma/dist):
//   1. chạy tests/fixtures/platform-setup.sql trên một DB TRỐNG;
//   2. ensurePlatform() với MULTI_TENANT=true (không đặt DEFAULT_COMPANY_NAME);
//   3. ghi công ty 2 (schema c_2) rồi installSyncTriggers(tx, 2, 'c_2');
//   4. chạy tests/fixtures/platform-snapshot.sql với search_path = pg_catalog, ghi tests/fixtures/platform-schema.txt.
// Chạy ở gốc repo:
//   pnpm install --frozen-lockfile --filter @trinity/prisma... && pnpm --filter @trinity/rbac build \
//     && pnpm --filter @trinity/prisma generate && pnpm --filter @trinity/prisma build
//   createdb trinity_platform_fixture
//   DATABASE_URL=postgresql://$USER@localhost:5432/trinity_platform_fixture \
//     node server/crates/trinity-db/scripts/gen-platform-fixture.cjs
//   dropdb trinity_platform_fixture
const path = require('node:path')
const fs = require('node:fs')

process.env.MULTI_TENANT = 'true'
delete process.env.DEFAULT_COMPANY_NAME

const root = path.resolve(__dirname, '../../../..')
const fixtures = path.resolve(__dirname, '../tests/fixtures')
const prisma = require(path.join(root, 'packages/prisma/dist'))

/** Câu lệnh của tệp SQL (mỗi câu kết thúc bằng `;` cuối dòng), bỏ dòng chú thích. */
function statements(file) {
  const text = fs
    .readFileSync(path.join(fixtures, file), 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
  return text
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;$/, ''))
    .filter(Boolean)
}

async function main() {
  const service = prisma.createPrismaService() // dựng client gốc (getBaseClient) như lúc boot
  const db = prisma.getBaseClient()
  const empty = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN ('platform', 'c_2')`,
  )
  if (empty[0].n !== 0) throw new Error('DB phải trống (đã có schema platform hoặc c_2)')
  for (const stmt of statements('platform-setup.sql')) await db.$executeRawUnsafe(stmt)

  await prisma.ensurePlatform()

  await db.$executeRawUnsafe(`INSERT INTO platform.companies (id, name, schema_name) VALUES (2, 'Công ty B', 'c_2')`)
  await db.$transaction((tx) => prisma.installSyncTriggers(tx, 2, 'c_2'))

  const snapshot = fs.readFileSync(path.join(fixtures, 'platform-snapshot.sql'), 'utf8')
  const rows = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO pg_catalog`)
    return tx.$queryRawUnsafe(snapshot)
  })
  const out = path.join(fixtures, 'platform-schema.txt')
  fs.writeFileSync(out, rows.map((r) => r.line).join('\n') + '\n')
  console.log(`${rows.length} dòng → ${path.relative(root, out)}`)
  await service.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
