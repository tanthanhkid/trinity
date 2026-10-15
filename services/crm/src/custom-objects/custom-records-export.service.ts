import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { csvCell, exportValue, vnDateTime } from './csv-format';
import { loadVisibleObject } from './custom-object-access';
import { CustomRecordsListService } from './custom-records-list.service';
import { LIMITS } from './field-types';
import { RecordPresenter } from './record-presenter.service';
import { scopeSql } from './record-query';
import type { ListCustomRecordsQueryDto } from './dto/custom-record.dto';

const BATCH = 1000;

export interface CsvResult {
  filename: string;
  body: string;
  total: number;
  exported: number;
  truncated: boolean;
}

/**
 * Xuất CSV (quyền `custom_records.export`, route kết thúc `/export`). Phạm vi = GIAO của phạm vi XEM và phạm vi XUẤT
 * (không xuất được thứ không xem được). Sắp xếp mới → cũ (id DESC) và cắt ở `exportRowCap`; NÓI RÕ khi cắt (cột cuối + header).
 */
@Injectable()
export class CustomRecordsExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly list: CustomRecordsListService,
    private readonly presenter: RecordPresenter,
  ) {}

  async exportCsv(user: AuthUser, key: string, q: ListCustomRecordsQueryDto): Promise<CsvResult> {
    const def = await loadVisibleObject(this.prisma, user, key);
    const [view, exp] = await Promise.all([this.scope.ownerIds(user, 'custom_records.view'), this.scope.ownerIds(user, 'custom_records.export')]);
    if (view === null || exp === null) throw new ForbiddenException('Bạn không có quyền xuất dữ liệu này');
    const header = ['ID', 'Mã', ...def.fields.map((f) => f.label), 'Người phụ trách', 'Ngày tạo', 'Cập nhật lần cuối'];
    const lines: string[] = [header.map(csvCell).join(',')];
    let cursor: string | undefined;
    let total = 0;
    let exported = 0;
    do {
      const take = Math.min(BATCH, LIMITS.exportRowCap - exported);
      const res = await this.list.queryRows(def, [scopeSql(view), scopeSql(exp)], {
        q: q.q, limit: take, cursor, sort: 'id', dir: 'desc', filter: q.filter, withTotal: cursor === undefined,
      });
      if (res.total !== null) total = res.total;
      for (const v of await this.presenter.present(def, user, res.rows)) {
        const cells = [v.id, v.code ?? '', ...def.fields.map((f) => exportValue(f, v)), v.owner_name ?? '', vnDateTime(v.created_at.toISOString()), vnDateTime(v.updated_at.toISOString())];
        lines.push(cells.map(csvCell).join(','));
        exported++;
      }
      cursor = res.next ?? undefined;
    } while (cursor && exported < LIMITS.exportRowCap);
    const truncated = total > exported;
    if (truncated) lines.push(csvCell(`# Đã cắt: chỉ xuất ${exported} bản ghi MỚI NHẤT trong tổng ${total}. Hãy lọc thu hẹp rồi xuất tiếp.`));
    const day = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
    return { filename: `${def.obj.key}-${day}.csv`, body: `﻿${lines.join('\r\n')}\r\n`, total, exported, truncated };
  }
}
