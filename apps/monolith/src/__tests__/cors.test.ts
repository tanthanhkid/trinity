import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isOriginAllowed } from '../bootstrap-app'

const ORIGINAL = process.env.NODE_ENV
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL
})

describe('isOriginAllowed', () => {
  test('dev: localhost bất kỳ cổng được phép', () => {
    process.env.NODE_ENV = 'development'
    assert.equal(isOriginAllowed('http://localhost:5173', 'https://crm.example.com'), true)
  })
  test('production: localhost không nằm trong CORS_ORIGIN bị chặn', () => {
    process.env.NODE_ENV = 'production'
    assert.equal(isOriginAllowed('http://localhost:5173', 'https://crm.example.com'), false)
  })
  test('production: localhost ghi rõ trong CORS_ORIGIN vẫn được phép', () => {
    process.env.NODE_ENV = 'production'
    assert.equal(isOriginAllowed('http://localhost:3000', 'http://localhost:3000'), true)
  })
  test('production: origin cấu hình và subdomain wildcard được phép', () => {
    process.env.NODE_ENV = 'production'
    assert.equal(isOriginAllowed('https://crm.example.com', 'https://crm.example.com'), true)
    assert.equal(isOriginAllowed('https://a.example.com', '*.example.com'), true)
    assert.equal(isOriginAllowed('https://evil.com', '*.example.com'), false)
  })
})
