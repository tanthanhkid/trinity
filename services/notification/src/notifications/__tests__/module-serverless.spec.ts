describe('NotificationsModule — không @Cron/ScheduleModule ở serverless', () => {
  const old = process.env.TRINITY_RUNTIME
  afterEach(() => {
    if (old === undefined) delete process.env.TRINITY_RUNTIME
    else process.env.TRINITY_RUNTIME = old
    jest.resetModules()
  })

  function meta() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NotificationsModule: M } = require('../notifications.module') as { NotificationsModule: object }
    return {
      providers: (Reflect.getMetadata('providers', M) as Array<{ name?: string }>).map((p) => p.name),
      imports: (Reflect.getMetadata('imports', M) as Array<{ module?: { name: string }; name?: string }>).map(
        (i) => i.module?.name ?? i.name,
      ),
    }
  }

  it('serverless: thiếu NotificationsScheduler và ScheduleModule', () => {
    process.env.TRINITY_RUNTIME = 'serverless'
    jest.resetModules()
    const m = meta()
    expect(m.providers).not.toContain('NotificationsScheduler')
    expect(m.imports).not.toContain('ScheduleModule')
  })

  it('không cờ: giữ NotificationsScheduler + ScheduleModule như cũ', () => {
    delete process.env.TRINITY_RUNTIME
    jest.resetModules()
    const m = meta()
    expect(m.providers).toContain('NotificationsScheduler')
    expect(m.imports).toContain('ScheduleModule')
  })
})
