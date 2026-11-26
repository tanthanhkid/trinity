#!/usr/bin/env node
/**
 * Sinh `expected.json` của test K36 từ BẢN NODE: chạy `publishIntegrationEvent` (packages/prisma) và đúng lời gọi
 * `notificationLog.createMany` của `NotificationsService.createPendingLogs` (services/crm) cho từng kịch bản trong
 * `scenarios.json`, rồi đọc lại các dòng đã ghi (payload so theo `payload::text` của jsonb) (bỏ cột sinh ra lúc chạy: id, created_at, sent_at).
 *
 *   DATABASE_URL=postgresql://localhost:5432/trinity_<tên> node gen.cjs            # in ra stdout
 *   DATABASE_URL=... node gen.cjs > expected.json
 *
 * Cần đã build `@trinity/prisma` và DB đã migrate; bảng `integration_events`, `notification_logs` bị TRUNCATE (dùng DB riêng).
 */
const path = require('path')
const root = path.resolve(__dirname, '../../../../../..')
const { PrismaClient } = require(path.join(root, 'node_modules/.pnpm/node_modules/@prisma/client'))
const { publishIntegrationEvent } = require(path.join(root, 'packages/prisma/dist/index.js'))
const { scenarios } = require('./scenarios.json')

async function main() {
  const prisma = new PrismaClient()
  await prisma.$executeRawUnsafe('TRUNCATE integration_events, notification_logs RESTART IDENTITY CASCADE')
  const out = []
  for (const s of scenarios) {
    await prisma.$transaction(async (tx) => {
      // notification_logs.recipient_id có FK tới users; DB mẫu rỗng ⇒ bỏ kiểm FK CHỈ trong giao dịch này (SET LOCAL, không rò sang kết nối khác của pool)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      if (s.event) await publishIntegrationEvent(tx, s.event.type, s.event.payload, { resourceId: s.event.id, actorUserId: s.event.actor })
      if (s.notify) {
        await tx.notificationLog.createMany({
          data: s.notify.map((n) => ({
            recipient_id: n.recipient_id, event_type: n.event_type, channel: 'in_app', title: n.title, body: n.body,
            status: 'sent', sent_at: new Date(), action_url: n.action_url ?? null,
          })),
          skipDuplicates: true,
        })
      }
    })
    const events = await prisma.$queryRawUnsafe('SELECT event_type, resource, resource_id, payload::text AS payload, actor_user_id, dispatched_at IS NULL AS pending FROM integration_events ORDER BY id')
    const notes = await prisma.$queryRawUnsafe('SELECT recipient_id, event_type, channel, title, body, status, retry_count, is_read, action_url, sent_at IS NOT NULL AS sent FROM notification_logs ORDER BY id')
    out.push({ name: s.name, events, notifications: notes })
    await prisma.$executeRawUnsafe('TRUNCATE integration_events, notification_logs RESTART IDENTITY CASCADE')
  }
  await prisma.$disconnect()
  process.stdout.write(JSON.stringify({ scenarios: out }, null, 2) + '\n')
}
main().catch((e) => { console.error(e); process.exit(1) })
