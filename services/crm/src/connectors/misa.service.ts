import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { decryptSecret, encryptSecret, isSecretKeyConfigured, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { CommerceSyncService, type SyncOwner } from './commerce-sync.service';
import { ConnectorsService } from './connectors.service';
import { MISA_DATA_TYPE, MisaClient, mapMisaCustomer, mapMisaItem, misaAppId } from './misa';

type Kind = 'customers' | 'items';
/** Mỗi lần đồng bộ tối đa ngần này trang (100 bản ghi/trang) mỗi loại. */
const MAX_PAGES = 5;

export interface MisaSettings {
  company_code: string;
  cursors?: Partial<Record<Kind, string>>;
  /** Mốc riêng cho danh sách đã xoá (get_dictionary_delete). */
  del_cursors?: Partial<Record<Kind, string>>;
  next_skip?: Partial<Record<Kind, number>>;
  counts?: Partial<Record<Kind, number>>;
  last_sync_at?: string | null;
}

/** MISA AMIS Kế toán: khách (đối tượng) + hàng hoá vào CRM. MISA không có webhook ⇒ đồng bộ bằng nút "Đồng bộ". */
@Injectable()
export class MisaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly sync: CommerceSyncService,
  ) {}

  configured(): boolean {
    return misaAppId() !== null;
  }

  async connect(input: { access_code?: string; company_code?: string }, userId: number, fetchFn: typeof fetch = fetch) {
    const appId = misaAppId();
    if (!appId) throw new ServiceUnavailableException('Máy chủ chưa đặt MISA_APP_ID (mã ứng dụng đối tác do MISA cấp) nên chưa kết nối được MISA.');
    if (!isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY nên chưa lưu được khoá.');
    const companyCode = String(input.company_code ?? '').trim();
    const old = await this.creds();
    const accessCode = String(input.access_code ?? '').trim() || (old && old.settings.company_code === companyCode ? old.accessCode : '');
    if (!/^[A-Za-z0-9_.-]{2,60}$/.test(companyCode)) throw new BadRequestException('Mã công ty MISA không hợp lệ.');
    if (accessCode.length < 16) throw new BadRequestException('Thiếu mã kết nối (AMIS Kế toán › Thiết lập › Kết nối ứng dụng).');
    try {
      await new MisaClient({ appId, accessCode, companyCode }, fetchFn).accessToken();
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const switched = !!old && old.settings.company_code !== companyCode;
    const settings: MisaSettings = switched || !old ? { company_code: companyCode } : { ...old.settings, company_code: companyCode };
    const data = { status: 'active', credentials_enc: encryptSecret(JSON.stringify({ access_code: accessCode }), loadSecretKey()), settings: settings as object, last_error: null, connected_by: userId };
    await this.prisma.connectorAccount.upsert({ where: { provider: 'misa' }, update: data, create: { provider: 'misa', ...data } });
    const first = await this.runSync(fetchFn).catch((e) => ({ error: (e as Error).message }));
    return { status: (await this.connectors.list()).find((x) => x.provider === 'misa'), first_sync: first };
  }

  async runSync(fetchFn: typeof fetch = fetch): Promise<{ added: Record<Kind, number>; more: boolean }> {
    const appId = misaAppId();
    const c = await this.creds();
    if (!appId || !c) throw new BadRequestException('Chưa kết nối MISA.');
    const client = new MisaClient({ appId, accessCode: c.accessCode, companyCode: c.settings.company_code }, fetchFn);
    const owner = await this.owner();
    const cursors = { ...(c.settings.cursors ?? {}) };
    const nextSkip = { ...(c.settings.next_skip ?? {}) };
    const delCursors = { ...(c.settings.del_cursors ?? {}) };
    const counts = { ...(c.settings.counts ?? {}) };
    const added = { customers: 0, items: 0 } as Record<Kind, number>;
    let more = false;
    try {
      for (const kind of ['customers', 'items'] as const) {
        let skip = nextSkip[kind] ?? 0;
        let cursorOut: string | null = null;
        let unfinished = false;
        for (let p = 0; p < MAX_PAGES; p++) {
          const page = await client.dictionary(kind === 'customers' ? MISA_DATA_TYPE.customer : MISA_DATA_TYPE.item, skip, cursors[kind] ?? null);
          for (const row of page.rows) await this.apply(c.settings.company_code, kind, row, owner);
          added[kind] += page.rows.length;
          skip += page.rows.length;
          cursorOut = page.last_sync_time ?? cursorOut;
          if (page.rows.length < 100) break;
          if (p === MAX_PAGES - 1) unfinished = true;
        }
        if (unfinished) {
          nextSkip[kind] = skip; // lần sau đọc tiếp từ đây, cùng mốc
          more = true;
        } else {
          delete nextSkip[kind];
          if (cursorOut) cursors[kind] = cursorOut;
        }
        counts[kind] = (counts[kind] ?? 0) + added[kind];
        // Bản ghi đã xoá bên MISA ⇒ đánh dấu removed (không xoá dữ liệu CRM).
        let dskip = 0;
        let dcursor: string | null = delCursors[kind] ?? null;
        for (let p = 0; p < MAX_PAGES; p++) {
          const del = await client.dictionaryDeleted(kind === 'customers' ? MISA_DATA_TYPE.customer : MISA_DATA_TYPE.item, dskip, delCursors[kind] ?? null);
          for (const row of del.rows) {
            const id = String(row[kind === 'customers' ? 'account_object_id' : 'inventory_item_id'] ?? row.id ?? '');
            if (id) await this.sync.markRemoved('misa', c.settings.company_code, kind === 'customers' ? 'customer' : 'product', id);
          }
          dskip += del.rows.length;
          dcursor = del.last_sync_time ?? dcursor;
          if (del.rows.length < 100) break;
        }
        if (dcursor) delCursors[kind] = dcursor;
      }
      await this.prisma.connectorAccount.update({ where: { provider: 'misa' }, data: { settings: { ...c.settings, cursors, del_cursors: delCursors, next_skip: nextSkip, counts, last_sync_at: new Date().toISOString() } as object } });
      await this.connectors.touch('misa');
    } catch (err) {
      await this.connectors.touch('misa', (err as Error).message);
      throw new BadRequestException((err as Error).message);
    }
    return { added, more };
  }

  private async apply(account: string, kind: Kind, row: Record<string, unknown>, owner: SyncOwner): Promise<void> {
    if (kind === 'customers') {
      const c = mapMisaCustomer(row);
      if (c) await this.sync.upsertCustomer('misa', account, c, owner);
    } else {
      const p = mapMisaItem(row);
      if (p) await this.sync.upsertProduct('misa', account, p);
    }
  }

  private async creds(): Promise<{ accessCode: string; settings: MisaSettings } | null> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'misa' } });
    if (!r || r.status === 'disconnected' || !r.credentials_enc || !isSecretKeyConfigured()) return null;
    return { accessCode: (JSON.parse(decryptSecret(r.credentials_enc, loadSecretKey())) as { access_code: string }).access_code, settings: r.settings as unknown as MisaSettings };
  }

  private async owner(): Promise<SyncOwner> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'misa' }, select: { connected_by: true } });
    const u = r ? await this.prisma.user.findUnique({ where: { id: r.connected_by }, select: { id: true, team_id: true } }) : null;
    return { id: u?.id ?? r?.connected_by ?? 0, team_id: u?.team_id ?? null };
  }
}
