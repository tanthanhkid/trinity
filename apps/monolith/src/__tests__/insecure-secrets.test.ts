import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { insecureSecrets } from '../bootstrap-app'

const good = { JWT_SECRET: 'a'.repeat(64), SERVICE_SECRET: 'b'.repeat(64), DATABASE_URL: 'postgresql://trinity:Xy9@db:5432/trinity' }

describe('insecureSecrets — chặn secret mẫu ở production', () => {
  test('secret sinh ngẫu nhiên đủ dài ⇒ không lỗi', () => {
    assert.deepEqual(insecureSecrets(good), [])
  })

  test('chép nguyên .env.example ⇒ báo từng mục, không lộ giá trị', () => {
    const out = insecureSecrets({
      JWT_SECRET: 'change-me-generate-with-openssl-rand-hex-32',
      SERVICE_SECRET: 'change-me-generate-with-openssl-rand-hex-32',
      DATABASE_URL: 'postgresql://trinity:change-me-db-password@localhost:5432/trinity',
    })
    assert.equal(out.length, 3)
    assert.ok(!out.join(' ').includes('generate-with'))
  })

  test('quá ngắn / thiếu JWT_SECRET / khoá tích hợp mẫu ⇒ lỗi', () => {
    assert.match(insecureSecrets({ ...good, JWT_SECRET: 'secret123' })[0], /ngắn hơn 32/)
    assert.ok(insecureSecrets({ ...good, JWT_SECRET: '' }).includes('Thiếu JWT_SECRET'))
    assert.match(insecureSecrets({ ...good, INTEGRATIONS_SECRET_KEY: 'change-me' })[0], /INTEGRATIONS_SECRET_KEY/)
  })
})
