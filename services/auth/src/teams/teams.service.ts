import { Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const teams = await this.prisma.team.findMany({
      select: {
        id: true,
        name: true,
        team_lead_id: true,
        users: { select: { id: true }, where: { status: 'active' } },
      },
      orderBy: { id: 'asc' },
    })

    const leadIds = teams.map((t) => t.team_lead_id).filter((id): id is number => id !== null)
    const leads = leadIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, full_name: true },
        })
      : []
    const leadMap = new Map(leads.map((l) => [l.id, l.full_name]))

    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      leadUserId: t.team_lead_id,
      lead: t.team_lead_id ? { name: leadMap.get(t.team_lead_id) ?? null } : null,
      memberCount: t.users.length,
    }))
  }

  async create(name: string, leadUserId: number) {
    return this.prisma.team.create({
      data: { name, team_lead_id: leadUserId },
      select: { id: true, name: true, team_lead_id: true },
    })
  }
}
