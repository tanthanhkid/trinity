import { describe, expect, it } from 'vitest'
import { Normalizer } from '../lib/normalize.js'

const DAY = 86_400_000
/** Cùng dữ liệu tương đối ("hôm nay", "3 ngày trước") ở hai ngày chạy khác nhau phải chuẩn hoá giống hệt. */
function sample(nowMs: number): unknown {
  const iso = (offsetDays: number): string => new Date(nowMs + offsetDays * DAY - 42_000).toISOString()
  const vnDay = (offsetDays: number): string => new Date(nowMs + offsetDays * DAY + 7 * 3_600_000).toISOString().slice(0, 10)
  return {
    id: 1000 + (nowMs % 97),
    owner_id: 7 + (nowMs % 13),
    created_at: iso(0),
    old_at: iso(-3),
    days: [vnDay(-2), vnDay(-1), vnDay(0)],
    token: `eyJhbGciOiJIUzI1NiJ9.${nowMs}.abc`,
    email: `u-${nowMs}@contract.test`,
  }
}

describe('Normalizer', () => {
  it('hai ngày chạy khác nhau cho kết quả chuẩn hoá giống hệt', () => {
    const t1 = Date.UTC(2026, 10, 26, 3, 14, 15)
    const t2 = Date.UTC(2026, 11, 3, 11, 59, 1)
    const a = new Normalizer(t1).normalize(sample(t1))
    const b = new Normalizer(t2).normalize(sample(t2))
    expect(a).toEqual(b)
    expect(a).toMatchObject({ created_at: '<now>', old_at: '<time:-3d>', days: ['<vn-day:-2>', '<vn-day:-1>', '<vn-day:0>'], token: '<token>' })
  })

  it('id tham chiếu người dùng chung dãy; id khác đánh số theo khoá; ngày ngoài cửa sổ giữ nguyên', () => {
    const out = new Normalizer(Date.UTC(2026, 10, 26)).normalize({
      assigned_to: 41,
      created_by: 42,
      closed_to: 41,
      contact_id: 9,
      deal_id: 9,
      fixed: '2019-05-01',
    })
    expect(out).toEqual({
      assigned_to: '<user:1>',
      created_by: '<user:2>',
      closed_to: '<user:1>',
      contact_id: '<id:contact_id:1>',
      deal_id: '<id:deal_id:1>',
      fixed: '2019-05-01',
    })
  })

  it('id số dạng chuỗi được chuẩn hoá như id số', () => {
    expect(new Normalizer().normalize({ contact_id: '9', assigned_to: '41', note: '123' })).toEqual({ contact_id: '<id:contact_id:1>', assigned_to: '<user:1>', note: '123' })
  })

  it('ngày Việt Nam: 17:30 UTC đã là ngày hôm sau theo giờ VN', () => {
    const t = Date.UTC(2026, 10, 26, 17, 30, 0)
    expect(new Normalizer(t).normalize({ d: '2026-11-27' })).toEqual({ d: '<vn-day:0>' })
  })

  it('con trỏ phân trang không bị che', () => {
    expect(new Normalizer().normalize({ next_cursor: 'abc123' })).toEqual({ next_cursor: 'abc123' })
  })
})
