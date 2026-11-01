#!/usr/bin/env node
/**
 * Deploy step for multi-tenant installs: bring every company schema to the latest migration.
 * Run after `prisma migrate deploy` (which migrates `public` = company 1), before switching traffic.
 *   MULTI_TENANT=true DATABASE_URL=... pnpm --filter @trinity/prisma migrate:companies
 */
process.env.MULTI_TENANT = 'true'
const { createPrismaService, ensurePlatform, migrateAllCompanies } = require('../dist')

;(async () => {
  const db = createPrismaService()
  let failed = 0
  try {
    await ensurePlatform()
    await migrateAllCompanies((msg) => {
      if (msg.includes('FAILED')) failed++
      console.log(msg)
    })
  } finally {
    await db.$disconnect()
  }
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
