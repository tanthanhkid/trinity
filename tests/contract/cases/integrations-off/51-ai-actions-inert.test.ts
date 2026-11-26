import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { makeUser } from '../../lib/mcp.js'

afterAll(closeDb)

/** Hồ sơ `integrations-off`: mọi route đề xuất AI trả 404 (deploy INERT); chuyển từ `ai-actions.e2e-spec.ts`. */
describe('cờ tắt ⇒ route đề xuất 404', () => {
  it('mọi route đề xuất 404', async () => {
    const u = await makeUser({ 'integrations.ai_connect': true, 'contacts.view': 'own' })
    const A = '/integrations/ai-actions'
    expect((await api.get(A, { token: u.token, ip: freshIp() })).status).toBe(404)
    expect((await api.get(`${A}/pending-count`, { token: u.token, ip: freshIp() })).status).toBe(404)
    expect((await api.post(`${A}/1/approve`, { token: u.token, ip: freshIp() })).status).toBe(404)
    expect((await api.post(`${A}/1/reject`, { token: u.token, ip: freshIp() })).status).toBe(404)
  })
})
