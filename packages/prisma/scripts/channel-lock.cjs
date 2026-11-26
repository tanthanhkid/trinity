#!/usr/bin/env node
/**
 * Platform-owner switch for outbound channels of one company (multi-tenant hosting).
 * Locked = every outbound send of that company is refused (Messenger, Zalo, comment replies, social posts,
 * broadcasts); inbound webhooks keep working. Needs MULTI_TENANT=true and the database URL.
 *
 *   pnpm --filter @trinity/prisma channel:lock -- list
 *   pnpm --filter @trinity/prisma channel:lock -- lock <companyId> [reason...]
 *   pnpm --filter @trinity/prisma channel:lock -- unlock <companyId>
 *   pnpm --filter @trinity/prisma channel:lock -- resume <companyId>   # end an automatic pause early
 */
process.env.MULTI_TENANT = 'true'
const { createPrismaService, ensurePlatform, setChannelLock, listChannelLocks, activeCompanyRef, runWithCompany } = require('../dist')

const [cmd, idArg, ...rest] = process.argv.slice(2).filter((a) => a !== '--')

function usage() {
  console.error('Usage: channel:lock -- list | lock <companyId> [reason] | unlock <companyId> | resume <companyId>')
  process.exit(2)
}

;(async () => {
  if (!['list', 'lock', 'unlock', 'resume'].includes(cmd)) usage()
  const db = createPrismaService()
  try {
    await ensurePlatform()
    if (cmd === 'list') {
      for (const c of await listChannelLocks()) {
        console.log(`${String(c.id).padStart(4)}  ${c.locked ? 'LOCKED  ' : 'open    '} ${c.status.padEnd(10)} ${c.name}${c.locked && c.reason ? `  — ${c.reason}` : ''}`)
      }
      return
    }
    const id = Number(idArg)
    if (!Number.isInteger(id) || id < 1) usage()
    if (cmd === 'resume') {
      const ref = await activeCompanyRef(id)
      if (!ref) {
        console.error(`Company ${id} not found or suspended`)
        process.exit(1)
      }
      const n = await runWithCompany(ref, async () => {
        const open = await db.$queryRawUnsafe(`SELECT kind, meta FROM channel_events WHERE kind IN ('auto_pause', 'auto_resume') ORDER BY id DESC LIMIT 1`)
        // Only a pause still in the future: an expired pause is already over, nothing to resume.
        const until = open[0] && open[0].meta && open[0].meta.until ? Date.parse(open[0].meta.until) : NaN
        if (!open[0] || open[0].kind !== 'auto_pause' || !(until > Date.now())) return 0
        await db.$executeRawUnsafe(`INSERT INTO channel_events (kind, message, meta) VALUES ('auto_resume', 'Chủ nền tảng mở lại gửi tự động', '{}'::jsonb)`)
        return 1
      })
      console.log(n ? `Company ${id}: automatic pause ended (takes effect within a few seconds)` : `Company ${id}: no automatic pause in effect`)
      return
    }
    const ok = await setChannelLock(id, cmd === 'lock', rest.join(' '))
    if (!ok) {
      console.error(`Company ${id} not found`)
      process.exit(1)
    }
    console.log(`Company ${id}: outbound channels ${cmd === 'lock' ? 'LOCKED' : 'unlocked'} (takes effect within ~10 seconds on every instance)`)
  } finally {
    await db.$disconnect()
  }
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
