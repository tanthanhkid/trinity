import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnershipReader, parseOwnership } from './ownership'

describe('tệp sở hữu (T01)', () => {
  let dir: string
  let file: string
  const logs: string[] = []
  const reader = () => createOwnershipReader({ path: () => file, log: (m) => logs.push(m) })
  const write = (text: string, mtime?: number) => {
    // ghi qua tệp tạm rồi đổi tên nguyên tử, như quy trình đổi sở hữu
    const tmp = join(dir, `t${Math.random()}`)
    writeFileSync(tmp, text)
    if (mtime) utimesSync(tmp, mtime, mtime)
    renameSync(tmp, file)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'own-'))
    file = join(dir, 'ownership.json')
    logs.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('không đặt biến hoặc tệp thiếu job: mọi thứ thuộc Node', () => {
    const none = createOwnershipReader({ path: () => undefined })
    expect(none.nodeRunsJob('lead-scoring.run')).toBe(true)
    expect(none.nodeRunsMigrate()).toBe(true)
    write('{"jobs":{"social.publish":"rust"}}')
    const r = reader()
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(true)
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    expect(r.nodeRunsMigrate()).toBe(true)
  })

  it('sửa tệp khi tiến trình đang chạy: lượt kế tiếp bỏ job, trả lại thì chạy lại, không cần khởi động lại', () => {
    write('{"jobs":{}}', 1_000_000)
    const r = reader()
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(true)
    // cùng kích thước và cùng mtime vẫn nhận ra nhờ inode đổi khi đổi tên nguyên tử
    write('{"jobs":{"lead-scoring.run":"rust"}}'.padEnd(10), 1_000_000)
    write('{"jobs":{"lead-scoring.run":"rust"}}', 1_000_000)
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(false)
    write('{"jobs":{"lead-scoring.run":"node"}}', 1_000_001)
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(true)
  })

  it('migrate nền theo tệp', () => {
    write('{"migrate":"rust"}')
    expect(reader().nodeRunsMigrate()).toBe(false)
    write('{"migrate":"node"}')
    expect(reader().nodeRunsMigrate()).toBe(true)
  })

  it('tệp hỏng: giữ bảng đang dùng, báo lỗi một lần; chưa có bảng thì mọi thứ thuộc Node', () => {
    write('{"jobs":{"social.publish":"rust"}}')
    const r = reader()
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    write('{"jobs":{"social.publish":')
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    expect(logs).toHaveLength(1)
    write('{"jobs":{"x":"python"}}')
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    expect(reader().nodeRunsJob('social.publish')).toBe(true) // chưa có bảng nào + tệp hỏng ⇒ mặc định Node
  })

  it('luật kiểm như bộ đọc Rust', () => {
    expect(() => parseOwnership('[]')).toThrow()
    expect(() => parseOwnership('{"job":{}}')).toThrow(/khoá lạ/)
    expect(() => parseOwnership('{"jobs":{"a":"RUST"}}')).toThrow()
    expect(() => parseOwnership('{"jobs":{" a":"rust"}}')).toThrow()
    expect(() => parseOwnership('{"migrate":"x"}')).toThrow()
    expect(() => parseOwnership('{"routes":{}}')).toThrow()
    expect(parseOwnership('{"routes":[],"jobs":{"a":"rust"},"migrate":"rust"}')).toEqual({ jobs: { a: 'rust' }, migrate: 'rust' })
  })

  it('hai tiến trình cùng tệp không bao giờ cùng bỏ một job: Node chạy khi và chỉ khi chủ là node', () => {
    const jobs = ['a', 'b', 'c']
    write('{"jobs":{"a":"rust","b":"node"}}')
    const r = reader()
    const rustRuns = (name: string) => parseOwnership('{"jobs":{"a":"rust","b":"node"}}').jobs[name] === 'rust'
    for (const j of jobs) expect(r.nodeRunsJob(j)).toBe(!rustRuns(j))
  })
})
