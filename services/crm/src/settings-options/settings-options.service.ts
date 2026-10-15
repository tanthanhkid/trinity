import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import { CreateOptionDto } from './dto/create-option.dto';
import { UpdateOptionDto } from './dto/update-option.dto';
import { QueryOptionsDto } from './dto/query-options.dto';
import { OPTION_SELECT, SettingOptionView } from './settings-options.types';

/** CRUD options cấu hình động. RBAC: đọc `@AuthOnly`, ghi `contacts.catalog` (ở controller). */
@Injectable()
export class SettingsOptionsService {
  private readonly logger = new Logger(SettingsOptionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryOptionsDto) {
    const activeOnly = query.active !== false;
    const where: { group_key?: string; is_active?: boolean } = {};
    if (query.group) where.group_key = query.group;
    if (activeOnly) where.is_active = true;

    const data = await this.prisma.settingOption.findMany({
      where,
      select: OPTION_SELECT,
      orderBy: [{ group_key: 'asc' }, { sort_order: 'asc' }, { id: 'asc' }],
      take: 500,
    });

    return { data: data as SettingOptionView[] };
  }

  async create(
    dto: CreateOptionDto,
    userId: number,
  ): Promise<SettingOptionView> {
    const duplicate = await this.prisma.settingOption.findUnique({
      where: {
        group_key_value: { group_key: dto.group_key, value: dto.value },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        `Giá trị "${dto.value}" đã tồn tại trong nhóm "${dto.group_key}"`,
      );
    }

    const created = await this.prisma.settingOption.create({
      data: {
        group_key: dto.group_key,
        value: dto.value,
        label: dto.label,
        sort_order: dto.sort_order ?? 0,
        is_active: dto.is_active ?? true,
        is_system: false,
        metadata: toJsonInput(dto.metadata),
        updated_by: userId,
      },
      select: OPTION_SELECT,
    });

    this.logger.log(
      `Option created: ${dto.group_key}/${dto.value} by user ${userId}`,
    );
    return created as SettingOptionView;
  }

  async update(
    id: number,
    dto: UpdateOptionDto,
    userId: number,
  ): Promise<SettingOptionView> {
    const existing = await this.prisma.settingOption.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException(`Không tìm thấy option ID ${id}`);
    }

    const updated = await this.prisma.settingOption.update({
      where: { id },
      data: {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.sort_order !== undefined ? { sort_order: dto.sort_order } : {}),
        ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
        ...(dto.metadata !== undefined
          ? { metadata: toJsonInput(dto.metadata) }
          : {}),
        updated_by: userId,
      },
      select: OPTION_SELECT,
    });

    this.logger.log(`Option updated: ID ${id} by user ${userId}`);
    return updated as SettingOptionView;
  }

  /**
   * Soft delete: set is_active=false.
   * is_system=true → throw 400.
   */
  async remove(
    id: number,
    userId: number,
  ): Promise<{ deleted: boolean; id: number }> {
    const existing = await this.prisma.settingOption.findUnique({
      where: { id },
      select: { id: true, is_system: true, is_active: true },
    });
    if (!existing) {
      throw new NotFoundException(`Không tìm thấy option ID ${id}`);
    }
    if (existing.is_system) {
      throw new BadRequestException(
        'Không xoá được giá trị hệ thống (is_system=true)',
      );
    }

    if (existing.is_active) {
      await this.prisma.settingOption.update({
        where: { id },
        data: { is_active: false, updated_by: userId },
      });
    }

    this.logger.log(`Option soft-deleted: ID ${id} by user ${userId}`);
    return { deleted: true, id };
  }
}

function toJsonInput(
  metadata: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (metadata == null) return Prisma.JsonNull;
  return metadata as Prisma.InputJsonValue;
}
