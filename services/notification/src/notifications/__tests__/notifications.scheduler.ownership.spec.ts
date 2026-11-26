import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotificationsScheduler } from '../notifications.scheduler'

describe('@Cron thông báo hẹn giờ theo tệp sở hữu (T01)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-notif-'))
  const file = join(dir, 'o.json')
  const prev = process.env.TRINITY_OWNERSHIP_FILE
  const put = (text: string) => {
    const tmp = join(dir, `t${Math.random()}`)
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  }
  beforeAll(() => {
    process.env.TRINITY_OWNERSHIP_FILE = file
    delete process.env.MULTI_TENANT
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.TRINITY_OWNERSHIP_FILE
    else process.env.TRINITY_OWNERSHIP_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  })

  it('Rust nhận job thì Node bỏ lượt, trả lại thì chạy tiếp', async () => {
    const processScheduled = jest.fn().mockResolvedValue(0)
    const s = new NotificationsScheduler({ processScheduled } as never)
    put('{"jobs":{}}')
    await s.processScheduledNotifications()
    expect(processScheduled).toHaveBeenCalledTimes(1)
    put('{"jobs":{"notification.scheduled":"rust"}}')
    await s.processScheduledNotifications()
    expect(processScheduled).toHaveBeenCalledTimes(1)
    put('{"jobs":{"notification.scheduled":"node"}}')
    await s.processScheduledNotifications()
    expect(processScheduled).toHaveBeenCalledTimes(2)
  })
})
