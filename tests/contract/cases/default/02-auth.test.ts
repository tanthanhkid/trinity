import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { config } from '../../lib/config.js'
import { golden, snap } from '../../lib/golden.js'

afterAll(closeDb)

describe('đăng nhập và validation hai chế độ', () => {
  it('đăng nhập đúng trả 200 kèm token; sai mật khẩu trả 401', async () => {
    const ok = await api.post('/auth/login', { body: { email: config.adminEmail, password: config.adminPassword }, ip: freshIp() })
    expect(ok.status).toBe(200)
    const bad = await api.post('/auth/login', { body: { email: config.adminEmail, password: 'sai-mat-khau-1' }, ip: freshIp() })
    expect(bad.status).toBe(401)
    golden('login-wrong-password', 'anon', snap(bad))
  })

  it('lenient: /auth/login bỏ trường lạ, vẫn 200', async () => {
    const res = await api.post('/auth/login', {
      body: { email: config.adminEmail, password: config.adminPassword, truong_la: 1 },
      ip: freshIp(),
    })
    expect(res.status).toBe(200)
  })

  it('strict: /contacts từ chối trường lạ bằng 400', async () => {
    const login = await api.post('/auth/login', { body: { email: config.adminEmail, password: config.adminPassword }, ip: freshIp() })
    const token = ((login.body as { access_token?: string; accessToken?: string }).access_token ??
      (login.body as { accessToken?: string }).accessToken) as string
    const res = await api.post('/contacts', { token, body: { phone: '0900000999', truong_la: 1 }, ip: freshIp() })
    expect(res.status).toBe(400)
    golden('contacts-unknown-field', 'admin', snap(res))
  })
})
