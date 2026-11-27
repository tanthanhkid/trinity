import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { compare, type Captured } from '../sweep/compare.js'
import { signToken } from '../sweep/jwt.js'
import { expandPaths, normalizeRoutePath, resolveParams, routeParams } from '../sweep/param-map.js'
import { buildReport, findLeaks, newResult, record, redactPathEntry } from '../sweep/report.js'

const cap = (body: unknown, status = 200, contentType = 'application/json'): Captured => ({
  status,
  contentType,
  bytes: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
})

describe('ánh xạ tham số → bảng', () => {
  it('bỏ regex Nest và tiền tố', () => {
    expect(normalizeRoutePath('/api/v1/management/attendance/:id(\\d+)/proof/:slot')).toBe('/management/attendance/:id/proof/:slot')
    expect(routeParams('/api/v1/custom-objects/:key/records/:id')).toEqual(['key', 'id'])
  })

  it('tham số cùng tên :id đi về bảng theo tiền tố route', () => {
    const sql = (p: string, n: string): string => {
      const s = resolveParams(p).sources.get(n)
      return s && 'sql' in s ? s.sql : ''
    }
    expect(sql('/api/v1/contacts/:id', 'id')).toContain('FROM contacts ')
    expect(sql('/api/v1/deals/:id', 'id')).toContain('FROM deals ')
    expect(sql('/api/v1/contacts/:contactId/activities', 'contactId')).toContain('FROM contacts ')
    expect(sql('/api/v1/custom-objects/:key/records/:id', 'key')).toContain('key AS v FROM custom_objects')
    expect(sql('/api/v1/custom-objects/:key/records/:id', 'id')).toContain('FROM custom_records')
    expect(sql('/api/v1/kanban/cards/:cardId/checklist-items', 'cardId')).toContain('FROM kanban_cards')
  })

  it('tham số chưa có quy tắc được liệt kê, không đoán', () => {
    const r = resolveParams('/api/v1/unknown/:thing/x')
    expect(r.missing).toEqual(['thing'])
    expect(r.sources.size).toBe(0)
  })

  it('mọi route có tham số trong routes.json hiện tại: tham số nào thiếu quy tắc thì in ra để rà (không fail)', () => {
    const f = path.resolve(__dirname, '../../../server/contracts/routes.json')
    const rows = (JSON.parse(fs.readFileSync(f, 'utf8')) as { routes: Array<{ method: string; path: string }> }).routes
    const gets = rows.filter((r) => r.method === 'GET' && routeParams(r.path).length > 0)
    expect(gets.length).toBeGreaterThan(0)
    const missing = gets.filter((r) => resolveParams(r.path).missing.length > 0).map((r) => r.path)
    // Các route công khai/ký token (:token/:name, :tid…) có thể chưa có nguồn: chấp nhận, nhưng không vượt quá một phần nhỏ.
    expect(missing.length).toBeLessThan(gets.length / 4)
  })

  it('expandPaths xoay vòng giá trị, từ chối giá trị lạ, trả rỗng nếu thiếu', () => {
    const v = new Map([['id', ['5', '4', '3']]])
    expect(expandPaths('/api/v1/deals/:id', v, 2)).toEqual(['/deals/5', '/deals/4'])
    expect(expandPaths('/api/v1/deals/:id', new Map([['id', ['1/../../x', '7']]]), 5)).toEqual(['/deals/7'])
    expect(expandPaths('/api/v1/deals/:id', new Map(), 5)).toEqual([])
    expect(expandPaths('/api/v1/health', new Map(), 5)).toEqual(['/health'])
    const two = expandPaths('/api/v1/custom-objects/:key/records/:id', new Map([['key', ['a', 'b']], ['id', ['1', '2']]]), 10)
    expect(two).toHaveLength(4)
    expect(new Set(two).size).toBe(4)
  })
})

describe('so sánh như shadow', () => {
  it('giống nhau → không khác biệt; khác thì chỉ có đường dẫn + loại', () => {
    expect(compare(cap({ a: 1, b: [1, 2] }), cap({ b: [1, 2], a: 1 })).entries).toEqual([])
    const d = compare(cap({ a: 1, s: 'bí mật', l: [1] }), cap({ a: 2, s: 'khác', l: [1, 2], extra: true }))
    expect(d.entries).toEqual(['$.a|value', '$.extra|missing_in_node', '$.l[]|array_length', '$.s|value'])
    expect(JSON.stringify(d)).not.toContain('bí mật')
  })

  it('giờ máy chủ vừa rồi không phải khác biệt; mã trạng thái khác thì có', () => {
    const now = Date.now()
    const iso = (ms: number): string => new Date(ms).toISOString()
    expect(compare(cap({ t: iso(now - 1000) }), cap({ t: iso(now) }), now).entries).toEqual([])
    expect(compare(cap({ t: iso(now - 86_400_000) }), cap({ t: iso(now - 86_400_000 + 1000) }), now).entries).toEqual(['$.t|value']) // xa hiện tại: dữ liệu, không phải giờ máy chủ
    expect(compare(cap({ t: iso(now - 60_000) }), cap({ t: iso(now - 5000) }), now).entries).toEqual(['$.t|value'])
    expect(compare(cap({}, 200), cap({}, 404)).statusMismatch).toBe(true)
  })

  it('không phải JSON: so byte, chỉ báo <body>', () => {
    expect(compare(cap('abc', 200, 'text/csv'), cap('abd', 200, 'text/csv')).entries).toEqual(['<body>|body'])
    expect(compare(cap('abc', 200, 'text/csv'), cap('abc', 200, 'text/csv')).entries).toEqual([])
  })
})

describe('báo cáo không chứa giá trị dữ liệu', () => {
  it('khoá lạ (có thể là dữ liệu) bị thay bằng <key>', () => {
    expect(redactPathEntry('$.items[].name|value')).toBe('$.items[].name|value')
    expect(redactPathEntry('$.Nguyễn Văn A.phone|value')).toBe('$.<key>.phone|value')
    expect(redactPathEntry('$.a@b.com|type')).toBe('$.<key>.com|type')
    expect(redactPathEntry('$.12345|value')).toBe('$.<key>|value')
    expect(redactPathEntry('<content-type>|content_type')).toBe('<content-type>|content_type')
  })

  it('báo cáo đầu ra sạch; thêm giá trị lạ bị findLeaks bắt', () => {
    const r = newResult('GET /deals/:id', false, 2)
    record(r, compare(cap({ name: 'Công ty ABC', phone: '0901234567' }), cap({ name: 'Khác', phone: '0901234567' })))
    record(r, compare(cap({ x: 1 }), cap({ x: 1 })))
    const rep = buildReport([r])
    const text = JSON.stringify(rep)
    expect(text).not.toContain('ABC')
    expect(text).not.toContain('0901234567')
    expect(rep.routes[0]).toMatchObject({ samples: 2, equal: 1, different: 1, reached_min_samples: true })
    expect(findLeaks(rep)).toEqual([])
    const bad = newResult('GET /deals/123456/Công ty ABC', false, 1)
    expect(findLeaks(buildReport([bad]))).toContain('route')
  })

  it('route chưa đủ mẫu hiện trong summary', () => {
    const r = newResult('GET /x', true, 50)
    r.noSampler = ['id']
    expect(buildReport([r]).summary.below_min_samples).toEqual(['GET /x'])
  })
})

describe('token', () => {
  it('HS256 đúng định dạng, từ chối bí mật ngắn', () => {
    const t = signToken('x'.repeat(32), { sub: 1, email: 'a@b.c' }, 60, 1000)
    const [h, b] = t.split('.')
    expect(JSON.parse(Buffer.from(h as string, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(b as string, 'base64url').toString())).toMatchObject({ sub: 1, iat: 1000, exp: 1060 })
    expect(() => signToken('ngan', { sub: 1, email: 'a@b.c' })).toThrow()
  })
})
