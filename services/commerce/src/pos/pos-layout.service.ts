import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import {
  CreateAreaDto, CreateModifierDto, CreateTableDto, ListModifiersQueryDto, UpdateAreaDto, UpdateModifierDto, UpdateTableDto,
} from './dto/shift-catalog.dto';
import { num } from './pos-mapper';

const isUnique = (e: unknown) => (e as { code?: string }).code === 'P2002';
const isMissing = (e: unknown) => (e as { code?: string }).code === 'P2025';

/** Khu vực, bàn, tuỳ chọn món. Ghi = quản lý; đọc = mọi role bán hàng (controller gate). */
@Injectable()
export class PosLayoutService {
  constructor(private readonly prisma: PrismaService) {}

  private async guard<T>(fn: () => Promise<T>, dupMsg: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isUnique(e)) throw new ConflictException(dupMsg);
      if (isMissing(e)) throw new NotFoundException('Không tìm thấy');
      throw e;
    }
  }

  listAreas() {
    return this.prisma.posArea.findMany({ orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] });
  }
  createArea(dto: CreateAreaDto) {
    return this.guard(() => this.prisma.posArea.create({ data: dto }), 'Tên khu vực đã tồn tại');
  }
  updateArea(id: number, dto: UpdateAreaDto) {
    return this.guard(() => this.prisma.posArea.update({ where: { id }, data: dto }), 'Tên khu vực đã tồn tại');
  }

  /** Bàn kèm `open_order` (đơn đang mở ở bàn đó) để FE tô màu bàn có khách. */
  async listTables() {
    const [tables, open] = await Promise.all([
      this.prisma.posTable.findMany({ orderBy: [{ area_id: 'asc' }, { sort_order: 'asc' }, { id: 'asc' }] }),
      this.prisma.posOrder.findMany({
        where: { status: 'open', table_id: { not: null } }, select: { id: true, code: true, table_id: true, total: true },
      }),
    ]);
    return tables.map((t) => {
      const o = open.find((x) => x.table_id === t.id);
      return { ...t, open_order: o ? { id: o.id, code: o.code, total: num(o.total) } : null };
    });
  }
  async createTable(dto: CreateTableDto) {
    const area = await this.prisma.posArea.findUnique({ where: { id: dto.area_id }, select: { id: true } });
    if (!area) throw new NotFoundException('Khu vực không tồn tại');
    return this.guard(() => this.prisma.posTable.create({ data: dto }), 'Tên bàn đã tồn tại trong khu vực');
  }
  updateTable(id: number, dto: UpdateTableDto) {
    return this.guard(() => this.prisma.posTable.update({ where: { id }, data: dto }), 'Tên bàn đã tồn tại trong khu vực');
  }

  async listModifiers(q: ListModifiersQueryDto, canSeeInactive: boolean) {
    const rows = await this.prisma.posModifier.findMany({
      where: q.include_inactive && canSeeInactive ? {} : { is_active: true },
      orderBy: [{ group_name: 'asc' }, { sort_order: 'asc' }, { id: 'asc' }],
    });
    return rows.map((m) => ({ ...m, price_delta: num(m.price_delta) }));
  }
  async createModifier(dto: CreateModifierDto) {
    const m = await this.guard(
      () => this.prisma.posModifier.create({ data: { ...dto, price_delta: BigInt(dto.price_delta ?? 0) } }),
      'Tuỳ chọn đã tồn tại trong nhóm',
    );
    return { ...m, price_delta: num(m.price_delta) };
  }
  async updateModifier(id: number, dto: UpdateModifierDto) {
    const data = { ...dto, price_delta: dto.price_delta == null ? undefined : BigInt(dto.price_delta) };
    const m = await this.guard(() => this.prisma.posModifier.update({ where: { id }, data }), 'Tuỳ chọn đã tồn tại trong nhóm');
    return { ...m, price_delta: num(m.price_delta) };
  }
}
