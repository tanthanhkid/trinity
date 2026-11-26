import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, seedContact, seedUser, type SeededUser } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { golden, snap, type Role } from '../../lib/golden.js'
import { loginAdmin, loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/** `contacts.phone_full` đổi hình dạng response (SĐT đầy đủ hay bị che): golden ghi cho 3 vai. */
describe('danh sách khách theo ba vai', () => {
  let leader: SeededUser
  let sale: SeededUser
  beforeAll(async () => {
    leader = await seedUser({ label: 'leader', grants: { 'contacts.view': 'all', 'contacts.phone_full': 'all' } })
    sale = await seedUser({ label: 'sale', grants: { 'contacts.view': 'own' } })
    await seedContact({ phone: '0922000111', name: 'Khách vai', ownerId: sale.id, daysAgo: 2 })
    await control.flushCache()
  })

  it('Sale thấy SĐT bị che, Trưởng nhóm và Quản trị thấy đầy đủ', async () => {
    const tokens: [Role, string][] = [
      ['admin', (await loginAdmin()).token],
      ['leader', (await loginSeeded(leader)).token],
      ['sale', (await loginSeeded(sale)).token],
    ]
    const phones: Record<string, string | undefined> = {}
    for (const [role, token] of tokens) {
      const res = await api.get('/contacts?search=0922000111&limit=5', { token, ip: freshIp() })
      expect(res.status, role).toBe(200)
      const rows = ((res.body as { data?: { phone?: string }[]; items?: { phone?: string }[] }).data ??
        (res.body as { items?: { phone?: string }[] }).items ?? []) as { phone?: string }[]
      phones[role] = rows[0]?.phone
      golden('contacts-list', role, snap(res))
    }
    expect(phones.leader).toBe('0922000111')
    expect(phones.sale).not.toBe('0922000111')
  })
})
