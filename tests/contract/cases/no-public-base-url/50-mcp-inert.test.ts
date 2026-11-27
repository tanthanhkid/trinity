import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { call, freshIp } from '../../lib/http.js'
import { rpc } from '../../lib/mcp.js'

afterAll(closeDb)

/** MCP INERT (hồ sơ `no-public-base-url`): /mcp trả 404 (chuyển từ `mcp.e2e-spec.ts`, ca "cờ tắt hoặc thiếu base URL"). */
describe('MCP INERT (no-public-base-url)', () => {
  it('/mcp trả 404', async () => {
    expect((await rpc(null, 'initialize', {})).status).toBe(404)
    expect((await call('GET', '/api/v1/mcp', { ip: freshIp() })).status).toBe(404)
  })
})
