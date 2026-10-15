import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException, ConflictException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { ScopeService, type AuthUser } from '@trinity/rbac-nest'
import { EmployeesService } from '../employees.service'

const mockPrisma = {
  employee: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
}

const mockScope = {
  ownerIds: jest.fn(),
}

const adminUser: AuthUser = { userId: 1, email: 'admin@example.com', isAdmin: true, grants: { 'employees.view': 'all' } }
const saleUser: AuthUser = { userId: 10, email: 'sales@example.com', isAdmin: false, grants: { 'employees.view': 'own' } }

describe('EmployeesService', () => {
  let service: EmployeesService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ScopeService, useValue: mockScope },
      ],
    }).compile()

    service = module.get<EmployeesService>(EmployeesService)
    jest.clearAllMocks()
    mockScope.ownerIds.mockResolvedValue('all')
  })

  describe('findAll', () => {
    it('returns employee list with user info (scope all -> where rỗng)', async () => {
      const employees = [
        {
          id: 1,
          user_id: 10,
          position: 'sales',
          department: 'KD',
          team_id: 1,
          salary_rule_id: 1,
          status: 'active',
          joined_at: new Date('2026-01-15'),
          created_at: new Date(),
          user: { full_name: 'Nguyen Van A', email: 'a@example.net', phone: '0901234567', avatar_url: null },
        },
      ]
      mockPrisma.employee.findMany.mockResolvedValue(employees)

      const result = await service.findAll({}, adminUser)
      expect(result).toEqual(employees)
      expect(mockPrisma.employee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [{}] } }),
      )
    })

    it('scope own -> lọc theo user_id của chính mình', async () => {
      mockScope.ownerIds.mockResolvedValue([10])
      mockPrisma.employee.findMany.mockResolvedValue([])

      await service.findAll({}, saleUser)
      expect(mockScope.ownerIds).toHaveBeenCalledWith(saleUser, 'employees.view')
      expect(mockPrisma.employee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [{ user_id: { in: [10] } }] } }),
      )
    })

    it('applies team_id filter', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([])

      await service.findAll({ team_id: 2 }, adminUser)
      expect(mockPrisma.employee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [{}], team_id: 2 } }),
      )
    })

    it('applies search filter on user full_name', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([])

      await service.findAll({ search: 'Nguyen' }, adminUser)
      expect(mockPrisma.employee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [{}],
            user: { full_name: { contains: 'Nguyen', mode: 'insensitive' } },
          },
        }),
      )
    })
  })

  describe('findById', () => {
    it('throws NotFoundException when employee not found', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue(null)

      await expect(service.findById(999, adminUser)).rejects.toThrow(NotFoundException)
    })

    it('throws NotFoundException (404, không phải 403) khi ngoài phạm vi', async () => {
      mockScope.ownerIds.mockResolvedValue([999])
      mockPrisma.employee.findUnique.mockResolvedValue({
        id: 1,
        user_id: 10,
        position: 'sales',
        department: 'KD',
        team_id: 1,
        salary_rule_id: 1,
        status: 'active',
        joined_at: new Date('2026-01-15'),
        created_at: new Date(),
        user: { full_name: 'A', email: 'a@example.net', phone: null, avatar_url: null, team: null },
        payslips: [],
        kpi_results: [],
      })

      await expect(service.findById(1, saleUser)).rejects.toThrow(NotFoundException)
    })

    it('returns employee with salary history and KPI summary', async () => {
      const employee = {
        id: 1,
        user_id: 10,
        position: 'sales',
        department: 'KD',
        team_id: 1,
        salary_rule_id: 1,
        status: 'active',
        joined_at: new Date('2026-01-15'),
        created_at: new Date(),
        user: {
          full_name: 'Nguyen Van A',
          email: 'a@example.net',
          phone: '0901234567',
          avatar_url: null,
          team: { id: 1, name: 'Chau' },
        },
        payslips: [
          { month: '2026-03', total: 15000000n, status: 'approved' },
        ],
        kpi_results: [],
      }
      mockPrisma.employee.findUnique.mockResolvedValue(employee)

      const result = await service.findById(1, adminUser)
      expect(result.full_name).toBe('Nguyen Van A')
      expect(result.salary_history).toEqual([
        { month: '2026-03', total: '15000000', status: 'approved' },
      ])
    })
  })

  describe('create', () => {
    it('throws ConflictException if user already has employee record', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue({ id: 1 })

      await expect(
        service.create({
          user_id: 10,
          position: 'sales',
          salary_rule_id: 1,
          joined_at: '2026-01-15',
        }),
      ).rejects.toThrow(ConflictException)
    })

    it('creates employee when user has no existing record', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue(null)
      const created = {
        id: 1,
        user_id: 10,
        position: 'sales',
        department: null,
        team_id: null,
        salary_rule_id: 1,
        status: 'active',
        joined_at: new Date('2026-01-15'),
        created_at: new Date(),
      }
      mockPrisma.employee.create.mockResolvedValue(created)

      const result = await service.create({
        user_id: 10,
        position: 'sales',
        salary_rule_id: 1,
        joined_at: '2026-01-15',
      })
      expect(result.id).toBe(1)
      expect(mockPrisma.employee.create).toHaveBeenCalled()
    })
  })

  describe('update', () => {
    it('throws NotFoundException when employee not found', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue(null)

      await expect(
        service.update(999, { position: 'team_lead' }),
      ).rejects.toThrow(NotFoundException)
    })

    it('updates employee fields', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue({ id: 1 })
      mockPrisma.employee.update.mockResolvedValue({
        id: 1,
        position: 'team_lead',
        status: 'active',
      })

      const result = await service.update(1, { position: 'team_lead' })
      expect(result.position).toBe('team_lead')
    })
  })

  describe('getCurrentMonth — theo giờ VN', () => {
    it('00:00–07:00 ngày mùng 1 VN (còn là hôm trước theo UTC) vẫn tính tháng mới', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-30T20:00:00Z')) // 03:00 ngày 01/10 giờ VN
      try {
        expect((service as unknown as { getCurrentMonth: () => string }).getCurrentMonth()).toBe('2026-10')
      } finally {
        jest.useRealTimers()
      }
    })
  })
})
