import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { WsEmitItemDto } from '../dto/event-payloads.dto'

const base = { recipient_id: 1, title: 't', body: 'b', event_type: 'x' }
const errs = (extra: object) => validate(plainToInstance(WsEmitItemDto, { ...base, ...extra }))

describe('WsEmitItemDto.action_url', () => {
  it('chỉ nhận đường dẫn tương đối bắt đầu bằng /', async () => {
    expect(await errs({ action_url: '/kanban?card=1' })).toHaveLength(0)
    expect(await errs({})).toHaveLength(0)
    expect(await errs({ action_url: null })).toHaveLength(0)
  })

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])('từ chối %s', async (u) => {
    expect((await errs({ action_url: u })).length).toBeGreaterThan(0)
  })
})
