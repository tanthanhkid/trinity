import { DeliveryService } from '../delivery.service'
import { NotifChannel } from '../dto/send-notification.dto'

describe('DeliveryService.createLog — giữ webhook_url khi hẹn giờ', () => {
  const build = () => {
    const prisma = { notificationLog: { create: jest.fn().mockResolvedValue({ id: 1 }) } }
    const svc = new DeliveryService(prisma as never, {} as never, {} as never, {} as never, {} as never)
    return { svc, prisma }
  }
  const base = { user_id: 1, channel: NotifChannel.WEBHOOK, title: 't', body: 'b' }

  it('lưu metadata.webhook_url vào cột webhook_url để lúc gửi vẫn có', async () => {
    const { svc, prisma } = build()
    await svc.createLog({ ...base, metadata: { webhook_url: 'https://hooks.example.com/x' } } as never)
    expect(prisma.notificationLog.create.mock.calls[0][0].data.webhook_url).toBe('https://hooks.example.com/x')
  })

  it('không có webhook_url → null (kênh khác không bị ảnh hưởng)', async () => {
    const { svc, prisma } = build()
    await svc.createLog({ ...base, channel: NotifChannel.IN_APP } as never)
    expect(prisma.notificationLog.create.mock.calls[0][0].data.webhook_url).toBeNull()
  })
})
