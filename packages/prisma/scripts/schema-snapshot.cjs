#!/usr/bin/env node
/**
 * Ảnh chụp schema Postgres đã chuẩn hoá (C05, docs/rust/PLAN.md mục 6.1): `server/contracts/schema.sql`.
 * Gồm schema `public` sau `prisma migrate deploy` cộng schema `platform` (tạo ngoài migration bởi `ensurePlatform`)
 * và các trigger đồng bộ đăng nhập/route. Dựng trên một DB tạm riêng rồi xoá, không đụng DB đang dùng.
 *
 *   node scripts/schema-snapshot.cjs --check   (mặc định) so với tệp đã commit; lệch thì thoát 1
 *   node scripts/schema-snapshot.cjs --write   sinh lại tệp
 *
 * Cần `psql` + `pg_dump` (bản 16) và một Postgres tạo được DB: lấy `SCHEMA_SNAPSHOT_ADMIN_URL`, thiếu thì `DATABASE_URL`
 * (chỉ dùng để nối và `CREATE DATABASE`). Đã build `@trinity/prisma` (`pnpm --filter "./packages/*" build`).
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../../..')
const OUT = path.join(ROOT, 'server/contracts/schema.sql')
const PKG = path.resolve(__dirname, '..')
const mode = process.argv.includes('--write') ? 'write' : 'check'

const adminRaw = process.env.SCHEMA_SNAPSHOT_ADMIN_URL || process.env.DATABASE_URL
if (!adminRaw) {
  console.error('Thiếu SCHEMA_SNAPSHOT_ADMIN_URL hoặc DATABASE_URL')
  process.exit(2)
}
const withDb = (raw, db) => {
  const u = new URL(raw)
  u.pathname = `/${db}`
  u.search = ''
  return u.toString()
}
const tmpDb = `trinity_schema_snapshot_${process.pid}`
const adminUrl = withDb(adminRaw, 'postgres')
const tmpUrl = withDb(adminRaw, tmpDb)

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} lỗi (${r.status}):\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

/** Bỏ phần phụ thuộc phiên bản/máy: dòng chú thích `--`, SET, set_config, \restrict (pg_dump mới), dòng trống thừa. */
function normalize(dump) {
  const lines = dump
    .split('\n')
    .filter((l) => !/^(--|SET |SELECT pg_catalog\.set_config|\\restrict|\\unrestrict)/.test(l))
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n*$/, '\n')
}

function snapshot() {
  run('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${tmpDb}`])
  try {
    const prisma = path.join(PKG, 'node_modules/.bin/prisma')
    run(prisma, ['migrate', 'deploy'], { DATABASE_URL: tmpUrl })
    run(
      process.execPath,
      ['-e', "process.env.MULTI_TENANT='true';const p=require('./dist');const db=p.createPrismaService();p.ensurePlatform().then(()=>db.$disconnect()).then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1)})"],
      { DATABASE_URL: tmpUrl, MULTI_TENANT: 'true' },
    )
  } catch (e) {
    dropDb()
    throw e
  }
  try {
    const dump = run('pg_dump', [
      '--schema-only', '--no-owner', '--no-privileges', '--no-tablespaces', '--no-publications', '--no-subscriptions',
      '-n', 'public', '-n', 'platform', '-T', 'public._prisma_migrations', '-T', 'public._prisma_migrations_*',
      tmpUrl,
    ])
    return normalize(dump)
  } finally {
    dropDb()
  }
}

function dropDb() {
  spawnSync('psql', [adminUrl, '-c', `DROP DATABASE IF EXISTS ${tmpDb} WITH (FORCE)`], { encoding: 'utf8' })
}

process.chdir(PKG)
let actual
try {
  actual = snapshot()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
if (mode === 'write') {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, actual)
  console.log(`Đã ghi ${path.relative(ROOT, OUT)} (${actual.split('\n').length - 1} dòng)`)
} else {
  const expected = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null
  if (expected === actual) {
    console.log('schema.sql khớp migration + platform')
  } else {
    const tmp = path.join(require('os').tmpdir(), `schema-actual-${process.pid}.sql`)
    fs.writeFileSync(tmp, actual)
    const d = spawnSync('diff', ['-u', OUT, tmp], { encoding: 'utf8' })
    console.error(d.stdout.split('\n').slice(0, 80).join('\n'))
    fs.unlinkSync(tmp)
    console.error('\nserver/contracts/schema.sql lệch schema thật. Sinh lại: pnpm --filter @trinity/prisma contract:schema')
    process.exit(1)
  }
}
