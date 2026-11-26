import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertOwnershipLoadable, createOwnershipReader, parseOwnership } from './ownership'

describe('tệp sở hữu (T01)', () => {
  let dir: string
  let file: string
  const logs: string[] = []
  const reader = () => createOwnershipReader({ path: () => file, log: (m) => logs.push(m) })
  const write = (text: string, mtime = 1_000_000) => {
    // ghi qua tệp tạm rồi đổi tên nguyên tử, như quy trình đổi sở hữu; mtime cố định để mtime/size không giúp được
    const tmp = join(dir, `t${Math.random()}`)
    writeFileSync(tmp, text)
    utimesSync(tmp, mtime, mtime)
    renameSync(tmp, file)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'own-'))
    file = join(dir, 'ownership.json')
    logs.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('không đặt biến: mọi thứ thuộc Node; tệp không ghi job thì job thuộc Node', () => {
    const none = createOwnershipReader({ path: () => undefined })
    expect(none.nodeRunsJob('lead-scoring.run')).toBe(true)
    expect(none.nodeRunsMigrate()).toBe(true)
    write('{"jobs":{"social.publish":"rust"}}')
    const r = reader()
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(true)
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    expect(r.nodeRunsMigrate()).toBe(true)
  })

  it('tên job lạ như __proto__/constructor không dính nguyên mẫu', () => {
    write('{"jobs":{"a":"rust"}}')
    const r = reader()
    expect(r.nodeRunsJob('__proto__')).toBe(true)
    expect(r.nodeRunsJob('constructor')).toBe(true)
    expect(parseOwnership('{"jobs":{"__proto__":"rust"}}').jobs.get('__proto__')).toBe('rust')
  })

  it('ghi đè cùng kích thước, cùng mtime, chỉ đổi node thành rust: lượt kế vẫn nhận ra, trả lại thì chạy lại', () => {
    write('{"jobs":{"lead-scoring.run":"node"}}')
    const r = reader()
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(true)
    write('{"jobs":{"lead-scoring.run":"rust"}}') // "node" và "rust" cùng 4 chữ
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(false)
    write('{"jobs":{"lead-scoring.run":"node"}}')
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(true)
  })

  it('migrate nền theo tệp', () => {
    write('{"migrate":"rust"}')
    expect(reader().nodeRunsMigrate()).toBe(false)
    write('{"migrate":"node"}')
    expect(reader().nodeRunsMigrate()).toBe(true)
  })

  it('tệp hỏng giữa chừng: giữ bảng đang dùng, báo lỗi một lần cho mỗi phiên bản tệp', () => {
    write('{"jobs":{"social.publish":"rust"}}')
    const r = reader()
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    write('{"jobs":{"social.publish":')
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    expect(logs).toHaveLength(1)
    write('{"jobs":{"social.publish":"node","social.publish":"rust"}}') // khoá trùng ⇒ hỏng ⇒ vẫn giữ bảng cũ
    expect(r.nodeRunsJob('social.publish')).toBe(false)
    write('{"jobs":{"social.publish":"node"}}')
    expect(r.nodeRunsJob('social.publish')).toBe(true)
  })

  it('đã đặt tệp mà hỏng hoặc thiếu lúc khởi động: không rơi về mọi-thứ-thuộc-Node, từ chối khởi động', () => {
    write('{"jobs":{"a":')
    const r = reader()
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(false)
    expect(r.nodeRunsMigrate()).toBe(false)
    expect(() => assertOwnershipLoadable(r)).toThrow(/từ chối khởi động/)
    rmSync(file)
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(false)
    expect(() => assertOwnershipLoadable(r)).toThrow(/không đọc được/)
    write('{"jobs":{}}') // sửa xong thì chạy lại được
    expect(r.nodeRunsJob('lead-scoring.run')).toBe(true)
    expect(() => assertOwnershipLoadable(r)).not.toThrow()
    expect(() => assertOwnershipLoadable(createOwnershipReader({ path: () => undefined }))).not.toThrow()
  })

  it('luật kiểm như bộ đọc Rust: cấp tệp, jobs, khoá trùng', () => {
    expect(() => parseOwnership('[]')).toThrow()
    expect(() => parseOwnership('{"job":{}}')).toThrow(/khoá lạ/)
    expect(() => parseOwnership('{"jobs":{"a":"RUST"}}')).toThrow()
    expect(() => parseOwnership('{"jobs":{" a":"rust"}}')).toThrow()
    expect(() => parseOwnership('{"migrate":"x"}')).toThrow()
    expect(() => parseOwnership('{"migrate":null}')).toThrow()
    expect(() => parseOwnership('{"routes":{}}')).toThrow()
    expect(() => parseOwnership('{"jobs":{"a":"rust","a":"node"}}')).toThrow(/hai lần/)
    expect(() => parseOwnership('{"migrate":"node","migrate":"rust"}')).toThrow(/hai lần/)
    expect(() => parseOwnership('{"routes":[{"prefix":"/a","owner":"rust","owner":"node"}]}')).toThrow(/hai lần/)
    expect(parseOwnership('{"routes":[],"jobs":{"a":"rust"},"migrate":"rust"}').jobs.get('a')).toBe('rust')
    // dấu ngoặc và dấu phẩy trong chuỗi không làm hỏng bộ quét khoá trùng
    expect(parseOwnership('{"jobs":{"a,\\"b{":"rust","c":"node"}}').jobs.size).toBe(2)
  })

  it('luật kiểm route như Rust: prefix, methods, owner, xung đột', () => {
    const r = (rule: string) => `{"routes":[${rule}]}`
    const ok = parseOwnership(r('{"prefix":"/api/v1/contacts","methods":["GET"],"owner":"rust"},{"prefix":"/api/v1/contacts","owner":"node"},{"prefix":"/","owner":"node"}'))
    expect(ok.jobs.size).toBe(0)
    for (const bad of [
      '{"owner":"rust"}',
      '{"prefix":"api","owner":"rust"}',
      '{"prefix":"/a/","owner":"rust"}',
      '{"prefix":"/a b","owner":"rust"}',
      '{"prefix":"/a//b","owner":"rust"}',
      '{"prefix":"/a/../b","owner":"rust"}',
      '{"prefix":"/a?x","owner":"rust"}',
      '{"prefix":"/a"}',
      '{"prefix":"/a","owner":"php"}',
      '{"prefix":"/a","owner":"rust","x":1}',
      '{"prefix":"/a","methods":[],"owner":"rust"}',
      '{"prefix":"/a","methods":null,"owner":"rust"}',
      '{"prefix":"/a","methods":["FETCH"],"owner":"rust"}',
      '{"prefix":"/a","methods":["GET","GET"],"owner":"rust"}',
      '{"prefix":"/a","methods":["GET","HEAD"],"owner":"rust"}',
      '"x"',
    ]) expect(() => parseOwnership(r(bad))).toThrow()
    // xung đột: cùng tiền tố cùng phương thức, hoặc hai dòng đều mọi phương thức; GET đã gồm HEAD
    expect(() => parseOwnership(r('{"prefix":"/a","owner":"rust"},{"prefix":"/a","owner":"node"}'))).toThrow(/đã có chủ/)
    expect(() => parseOwnership(r('{"prefix":"/a","methods":["GET"],"owner":"rust"},{"prefix":"/a","methods":["GET","POST"],"owner":"node"}'))).toThrow(/đã có chủ/)
    expect(() => parseOwnership(r('{"prefix":"/a","methods":["GET"],"owner":"rust"},{"prefix":"/a","methods":["HEAD"],"owner":"node"}'))).toThrow(/đã có chủ/)
  })

  it('tệp có route sai bị coi là hỏng cả tệp (giữ bảng cũ)', () => {
    write('{"jobs":{"a":"rust"}}')
    const r = reader()
    expect(r.nodeRunsJob('a')).toBe(false)
    write('{"jobs":{"a":"node"},"routes":[{"prefix":"x","owner":"rust"}]}')
    expect(r.nodeRunsJob('a')).toBe(false)
  })
})
