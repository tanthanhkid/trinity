import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { authContext, params, pkce } from '../../lib/oauth.js'
import { makeUser } from '../../lib/users.js'

afterAll(closeDb)

/** Hồ sơ `restricted-origins` (INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS=allowed.example): host ngoài danh sách bị từ chối. */
describe('INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS', () => {
  it('host ngoài danh sách ⇒ từ chối', async () => {
    const u = await makeUser({ 'integrations.ai_connect': true })
    const r = await authContext(u.token, params('https://chatgpt.com/client.json', pkce().challenge))
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_client')
  })
})
