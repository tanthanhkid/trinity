import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { PHONES, hook, lead, resetInbound, seedInboundFixtures, setupSource, type InboundFixtures } from '../../lib/inbound.js'
import { B, a, mk, resetWebhooks, startReceiver, st, tick, type Body, type Receiver } from '../../lib/webhooks.js'

afterAll(closeDb)
let rx: Receiver
let fx: InboundFixtures
beforeAll(async () => {
  rx = await startReceiver()
  fx = await seedInboundFixtures()
})
afterAll(async () => rx.close())
beforeEach(async () => {
  rx.seen.length = 0
  rx.status = 200
  await resetWebhooks()
  await resetInbound()
})

/** C12b, hồ sơ `private-targets` (cho phép đích nội bộ; e2e gốc đặt `INTEGRATIONS_ALLOW_PRIVATE_TARGETS`): khách vào qua webhook → bắn tiếp webhook ra. */
describe('tích hợp: khách vào qua webhook → bắn tiếp webhook ra', () => {
  it('contact.created từ webhook vào tới endpoint ra (SĐT che theo quyền chủ thể endpoint)', async () => {
    const { src } = await setupSource(fx)
    const watcher = await mk({ 'integrations.webhooks': true, 'contacts.view': 'all' }) // không phone_full
    await st(a(watcher.token).post(`${B}/endpoints`, { name: 'out', url: rx.url, events: ['contact.created'] }), 201)
    await new Promise((r) => setTimeout(r, 15))
    expect((await hook(src.token, lead(PHONES[3]))).status).toBe(200)
    const [created] = await q<{ id: number }>(`SELECT id FROM contacts WHERE phone = $1`, [PHONES[3]])
    await tick()
    expect(rx.seen).toHaveLength(1)
    const body = JSON.parse(rx.seen[0].body) as Body
    expect(body).toMatchObject({ type: 'contact.created', data: { origin: 'webhook_in', contact: { id: created.id, phone: '***804' } } })
    expect(rx.seen[0].body).not.toContain(PHONES[3])
  })
})
