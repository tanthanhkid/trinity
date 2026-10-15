import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
// Commerce service không có @prisma/client trực tiếp trong package.json (chỉ CRM có).
// Import Prisma namespace qua @trinity/prisma re-export để build trên CI không lỗi
// resolve module.
import { Prisma, PrismaService } from '@trinity/prisma';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

/** Shape returned to the web client. */
export interface ProjectDto {
  id: number;
  name: string;
  code: string;
  color: string | null;
  is_active: boolean;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(includeInactive = false): Promise<ProjectDto[]> {
    const where: Prisma.ProjectWhereInput = includeInactive ? {} : { is_active: true };
    const projects = await this.prisma.project.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
    return projects.map(toProjectDto);
  }

  async findOne(id: number): Promise<ProjectDto> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Dự án không tồn tại');
    return toProjectDto(project);
  }

  async create(dto: CreateProjectDto, userId: number): Promise<ProjectDto> {
    const existing = await this.prisma.project.findUnique({
      where: { code: dto.code },
    });
    if (existing) throw new ConflictException('Mã dự án đã tồn tại');
    try {
      const project = await this.prisma.project.create({
        data: {
          name: dto.name,
          code: dto.code,
          color: dto.color,
          created_by: userId,
        },
      });
      return toProjectDto(project);
    } catch (err) {
      // Hai request cùng mã chạy song song: request sau thắng kiểm tra rồi thua ở unique index.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Mã dự án đã tồn tại');
      }
      throw err;
    }
  }

  async update(id: number, dto: UpdateProjectDto): Promise<ProjectDto> {
    await this.findOne(id);
    // Dùng explicit object thay vì Prisma.ProjectUpdateInput typed intermediate
    // để tránh lỗi dual-Prisma-instance type mismatch khi commerce service resolve
    // @prisma/client từ root node_modules khác với trinity/node_modules.
    const data: { name?: string; color?: string | null; is_active?: boolean } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.is_active !== undefined) data.is_active = dto.is_active;
    const project = await this.prisma.project.update({ where: { id }, data });
    return toProjectDto(project);
  }

  async remove(id: number): Promise<ProjectDto> {
    await this.findOne(id);
    const project = await this.prisma.project.update({
      where: { id },
      data: { is_active: false },
    });
    return toProjectDto(project);
  }
}

function toProjectDto(p: {
  id: number;
  name: string;
  code: string;
  color: string | null;
  is_active: boolean;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    color: p.color,
    is_active: p.is_active,
    created_by: p.created_by,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}
