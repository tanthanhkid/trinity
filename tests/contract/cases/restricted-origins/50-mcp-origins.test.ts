import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { connect, makeUser, rpc } from '../../lib/mcp.js'

afterAll(closeDb)

/** `INTEGRATIONS_MCP_ALLOWED_ORIGINS=https://allowed.example` (hồ sơ `restricted-origins`): chuyển từ ca Origin của `mcp.e2e-spec.ts`. */
describe('MCP với danh sách Origin giới hạn', () => {
  let access = ''
  beforeAll(async () => {
    const u = await makeUser({ 'integrations.ai_connect': true })
    access = (await connect(u.token)).access
  })

  it('Origin trong danh sách ⇒ qua; Origin ngoài danh sách ⇒ 403; không Origin ⇒ qua', async () => {
    const withOrigin = (o: string) => rpc(access, 'tools/list', undefined, { origin: o })
    expect((await withOrigin('https://allowed.example')).status).toBe(200)
    expect((await withOrigin('https://evil.example.com')).status).toBe(403)
    expect((await rpc(access, 'tools/list')).status).toBe(200)
  })
})
