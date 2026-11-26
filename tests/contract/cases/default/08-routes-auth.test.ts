import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { call, freshIp } from '../../lib/http.js'

afterAll(closeDb)

interface Route {
  method: string
  path: string
  access: string
  deprecated: boolean
}

/** Ca sinh từ `server/contracts/routes.json`: route cần quyền, gọi không token ⇒ 401 (mẫu 15 route GET không tham số). */
describe('sinh ca từ routes.json: thiếu token', () => {
  const file = path.resolve(__dirname, '../../../../server/contracts/routes.json')
  const routes = (JSON.parse(fs.readFileSync(file, 'utf8')) as { routes: Route[] }).routes
  const sample = routes
    .filter((r) => r.method === 'GET' && r.access !== 'public' && r.access !== 'internal' && !r.path.includes(':') && !r.deprecated)
    .slice(0, 15)

  it.each(sample.map((r) => [r.path] as const))('GET %s không token => 401', async (p) => {
    const res = await call('GET', p, { ip: freshIp() })
    expect(res.status).toBe(401)
  })
})
