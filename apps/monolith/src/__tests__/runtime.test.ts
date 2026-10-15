import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isServerlessRuntime, withPooledParams } from '../runtime'

describe('isServerlessRuntime', () => {
  test('không đặt cờ → chế độ cũ', () => {
    assert.equal(isServerlessRuntime({}), false)
  })
  test('serverless (không phân biệt hoa-thường/khoảng trắng)', () => {
    assert.equal(isServerlessRuntime({ TRINITY_RUNTIME: ' Serverless ' }), true)
  })
  test('giá trị khác → chế độ cũ', () => {
    assert.equal(isServerlessRuntime({ TRINITY_RUNTIME: 'pm2' }), false)
  })
})

describe('withPooledParams (Neon pooler)', () => {
  test('host -pooler thiếu tham số → thêm pgbouncer + connection_limit=3', () => {
    const u = new URL(withPooledParams('postgresql://u:p@ep-a-b-pooler.sin1.aws.neon.tech/db?sslmode=require'))
    assert.equal(u.searchParams.get('sslmode'), 'require')
    assert.equal(u.searchParams.get('pgbouncer'), 'true')
    assert.equal(u.searchParams.get('connection_limit'), '3')
  })
  test('connection_limit=1 (tài liệu cũ) bị nâng lên sàn 3 — =1 làm treo transaction tương tác', () => {
    const u = new URL(withPooledParams('postgresql://u:p@ep-x-pooler.neon.tech/db?pgbouncer=true&connection_limit=1'))
    assert.equal(u.searchParams.get('connection_limit'), '3')
  })
  test('connection_limit >= sàn → giữ nguyên', () => {
    const u = 'postgresql://u:p@ep-x-pooler.neon.tech/db?pgbouncer=true&connection_limit=5'
    assert.equal(withPooledParams(u), u)
  })
  test('URL direct (không -pooler): chỉ đảm bảo connection_limit, KHÔNG pgbouncer', () => {
    const u = new URL(withPooledParams('postgresql://u:p@ep-a-b.sin1.aws.neon.tech/db?sslmode=require'))
    assert.equal(u.searchParams.get('pgbouncer'), null)
    assert.equal(u.searchParams.get('connection_limit'), '3')
    assert.equal(new URL(withPooledParams('postgresql://u:p@localhost:5432/db')).searchParams.get('connection_limit'), '3')
  })
  test('URL hỏng → giữ nguyên', () => {
    assert.equal(withPooledParams('not a url'), 'not a url')
  })
})
