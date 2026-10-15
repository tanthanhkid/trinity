import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { TemplatesService } from '../templates.service'
import { NotificationChannel } from '../dto/create-template.dto'

describe('TemplatesService', () => {
  let service: TemplatesService
  let prisma: {
    notificationTemplate: {
      findMany: jest.Mock
      findUnique: jest.Mock
      findFirst: jest.Mock
      create: jest.Mock
      update: jest.Mock
      delete: jest.Mock
    }
  }

  beforeEach(async () => {
    prisma = {
      notificationTemplate: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemplatesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile()

    service = module.get<TemplatesService>(TemplatesService)
  })

  const mockTemplate = {
    id: 1,
    name: 'lead_stage_changed',
    event_type: 'deal.stage.changed',
    channel: 'in_app',
    subject: 'Deal {{contactName}} chuyen buoc',
    body: 'Deal {{contactName}} da chuyen tu buoc {{fromStage}} sang buoc {{toStage}}',
    recipients_rule: { fields: ['assignedTo'] },
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  }

  describe('findAll', () => {
    it('tra ve danh sach templates', async () => {
      prisma.notificationTemplate.findMany.mockResolvedValue([mockTemplate])
      const result = await service.findAll()
      expect(result).toEqual([mockTemplate])
      expect(prisma.notificationTemplate.findMany).toHaveBeenCalledWith({
        orderBy: { created_at: 'desc' },
      })
    })
  })

  describe('findById', () => {
    it('tra ve template theo id', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(mockTemplate)
      const result = await service.findById(1)
      expect(result).toEqual(mockTemplate)
    })

    it('throw NotFoundException khi khong tim thay', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(null)
      await expect(service.findById(999)).rejects.toThrow(NotFoundException)
    })
  })

  describe('create', () => {
    it('cu phap Handlebars sai -> 400, khong luu', async () => {
      await expect(
        service.create({
          name: 'bad',
          event_type: 'x',
          channel: NotificationChannel.IN_APP,
          body: 'Xin chao {{#if}}',
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(prisma.notificationTemplate.create).not.toHaveBeenCalled()
    })

    it('helper lạ (không có sẵn) bị từ chối khi lưu — template là dữ liệu không tin cậy', async () => {
      const base = { name: 'x', event_type: 'x', channel: NotificationChannel.IN_APP }
      await service.create({ ...base, body: 'Chào {{customer.name}}, đơn {{order.code}}' }) // biến thường vẫn hợp lệ
      await service.create({ ...base, body: '{{#if a}}{{b}}{{/if}} {{#each items}}{{this}}{{/each}}' }) // helper có sẵn
      expect(prisma.notificationTemplate.create).toHaveBeenCalledTimes(2)
      await expect(service.create({ ...base, body: '{{dangerous "x" this}}' })).rejects.toBeInstanceOf(BadRequestException)
      expect(prisma.notificationTemplate.create).toHaveBeenCalledTimes(2)
    })

    it('tao template moi', async () => {
      prisma.notificationTemplate.create.mockResolvedValue(mockTemplate)
      const dto = {
        name: 'lead_stage_changed',
        event_type: 'deal.stage.changed',
        channel: NotificationChannel.IN_APP,
        subject: 'Deal {{contactName}} chuyen buoc',
        body: 'Deal {{contactName}} da chuyen tu buoc {{fromStage}} sang buoc {{toStage}}',
        recipients_rule: { fields: ['assignedTo'] },
      }
      const result = await service.create(dto)
      expect(result).toEqual(mockTemplate)
      expect(prisma.notificationTemplate.create).toHaveBeenCalled()
    })

    it('tao template voi is_active = true mac dinh', async () => {
      prisma.notificationTemplate.create.mockResolvedValue(mockTemplate)
      const dto = {
        name: 'test',
        event_type: 'test.event',
        channel: NotificationChannel.PUSH,
        body: 'Test body',
      }
      await service.create(dto)
      const createCall = prisma.notificationTemplate.create.mock.calls[0][0]
      expect(createCall.data.is_active).toBe(true)
    })
  })

  describe('update', () => {
    it('cap nhat template', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(mockTemplate)
      const updated = { ...mockTemplate, name: 'updated_name' }
      prisma.notificationTemplate.update.mockResolvedValue(updated)

      const result = (await service.update(1, { name: 'updated_name' })) as typeof updated
      expect(result.name).toBe('updated_name')
    })

    it('throw NotFoundException khi update template khong ton tai', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(null)
      await expect(service.update(999, { name: 'test' })).rejects.toThrow(
        NotFoundException,
      )
    })

    it('cap nhat is_active de disable template', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(mockTemplate)
      const disabled = { ...mockTemplate, is_active: false }
      prisma.notificationTemplate.update.mockResolvedValue(disabled)

      const result = (await service.update(1, { is_active: false })) as typeof disabled
      expect(result.is_active).toBe(false)
    })
  })

  describe('remove', () => {
    it('xoa template', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(mockTemplate)
      prisma.notificationTemplate.delete.mockResolvedValue(mockTemplate)

      await service.remove(1)
      expect(prisma.notificationTemplate.delete).toHaveBeenCalledWith({
        where: { id: 1 },
      })
    })

    it('throw NotFoundException khi xoa template khong ton tai', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(null)
      await expect(service.remove(999)).rejects.toThrow(NotFoundException)
    })
  })

  describe('render', () => {
    it('render template voi Handlebars', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValue(mockTemplate)

      const result = await service.render(1, {
        contactName: 'Nguyen Van A',
        fromStage: 'Moi',
        toStage: 'Dang tu van',
      })

      expect(result.body).toBe(
        'Deal Nguyen Van A da chuyen tu buoc Moi sang buoc Dang tu van',
      )
      expect(result.subject).toBe('Deal Nguyen Van A chuyen buoc')
    })

    it('render template khong co subject', async () => {
      const noSubject = { ...mockTemplate, subject: null }
      prisma.notificationTemplate.findUnique.mockResolvedValue(noSubject)

      const result = await service.render(1, { contactName: 'Test' })
      expect(result.subject).toBeNull()
    })
  })

  describe('renderByEventType', () => {
    it('render template theo event_type va channel', async () => {
      prisma.notificationTemplate.findFirst.mockResolvedValue(mockTemplate)

      const result = await service.renderByEventType(
        'deal.stage.changed',
        'in_app',
        {
          contactName: 'Nguyen Van B',
          fromStage: 'Dang tu van',
          toStage: 'Won',
        },
      )

      expect(result).not.toBeNull()
      expect(result!.body).toContain('Nguyen Van B')
    })

    it('tra ve null khi khong co template active', async () => {
      prisma.notificationTemplate.findFirst.mockResolvedValue(null)
      const result = await service.renderByEventType(
        'unknown.event',
        'push',
        {},
      )
      expect(result).toBeNull()
    })

    it('chi tim template co is_active = true', async () => {
      prisma.notificationTemplate.findFirst.mockResolvedValue(null)
      await service.renderByEventType('deal.stage.changed', 'in_app', {})

      expect(prisma.notificationTemplate.findFirst).toHaveBeenCalledWith({
        where: {
          event_type: 'deal.stage.changed',
          channel: 'in_app',
          is_active: true,
        },
      })
    })
  })
})
