import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { api, call, freshIp } from '../../lib/http.js'
import { REDIRECT } from '../../lib/oauth.js'
import { makeUser } from '../../lib/users.js'

afterAll(closeDb)

/** OAuth 2.1 INERT (INTEGRATIONS_MCP_ENABLED=false): mọi route OAuth/MCP trả 404 (chuyển từ `oauth.e2e-spec.ts`, ca "cờ tắt ⇒ INERT"). */
describe('cờ tắt ⇒ INERT (integrations-off)', () => {
  it('mọi route OAuth trả 404', async () => {
    const u = await makeUser({ 'integrations.ai_connect': true })
    const ip = (): { ip: string } => ({ ip: freshIp() })
    expect((await call('GET', '/api/v1/oauth/.well-known/oauth-authorization-server', ip())).status).toBe(404)
    expect((await call('GET', '/api/v1/oauth/protected-resource', ip())).status).toBe(404)
    expect((await call('POST', '/api/v1/oauth/register', { body: { redirect_uris: [REDIRECT] }, ...ip() })).status).toBe(404)
    expect((await call('POST', '/api/v1/oauth/token', { body: { grant_type: 'refresh_token' }, ...ip() })).status).toBe(404)
    expect((await api.post('/oauth/authorize/context', { token: u.token, body: { params: {} }, ...ip() })).status).toBe(404)
    expect((await api.get('/integrations/ai-connections', { token: u.token, ...ip() })).status).toBe(404)
  })

  it('/integrations/status báo mcp_url null, mcp tắt', async () => {
    const u = await makeUser({ 'integrations.ai_connect': true })
    const s = await api.get('/integrations/status', { token: u.token, ip: freshIp() })
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ mcp_enabled: false, mcp_url: null })
  })
})
