import { MisaClient, mapMisaCustomer, mapMisaItem, misaAppId, unwrapMisa } from '../misa';
import { MisaService } from '../misa.service';

const APP = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

describe('MISA — hàm thuần', () => {
  it('app_id đối tác đọc từ MISA_APP_ID', () => {
    expect(misaAppId({ MISA_APP_ID: APP } as never)).toBe(APP);
    expect(misaAppId({} as never)).toBeNull();
  });

  it('Data dạng chuỗi JSON (như MISA trả) ⇒ giải ra; Success=false ⇒ lỗi kèm thông điệp', () => {
    expect(unwrapMisa({ Success: true, Data: '[{"a":1}]' }, 'x')).toEqual([{ a: 1 }]);
    expect(() => unwrapMisa({ Success: false, ErrorMessage: 'Mã kết nối hết hạn' }, 'cấp token')).toThrow('MISA cấp token lỗi: Mã kết nối hết hạn');
  });

  it('đối tượng kế toán → khách; nhà cung cấp/nhân viên bỏ qua', () => {
    expect(mapMisaCustomer({ account_object_id: 'g1', account_object_code: 'KH001', account_object_name: 'Công ty ABC', mobile: '0912345678', email_address: 'a@abc.vn', is_customer: true })).toMatchObject({ external_id: 'g1', code: 'KH001', name: 'Công ty ABC', phone: '0912345678', email: 'a@abc.vn' });
    expect(mapMisaCustomer({ account_object_id: 'g2', is_vendor: true, is_customer: false })).toBeNull();
    expect(mapMisaCustomer({ account_object_id: 'g3', is_employee: true })).toBeNull();
    expect(mapMisaCustomer({ account_object_id: 'g4', account_object_name: 'Nhân viên mua hàng', is_employee: true, is_customer: true })).toMatchObject({ external_id: 'g4' });
  });

  it('vật tư hàng hoá', () => {
    expect(mapMisaItem({ inventory_item_id: 'i1', inventory_item_code: 'VT01', inventory_item_name: 'Giấy A4', unit_price: 55000, unit_name: 'Ram' })).toMatchObject({ external_id: 'i1', code: 'VT01', name: 'Giấy A4', price: 55000 });
  });

  it('client: lấy token rồi gọi get_dictionary với X-MISA-AccessToken, đọc LastSyncTime', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/oauth/actopen/connect')) return new Response(JSON.stringify({ Success: true, Data: '{"access_token":"tok-1"}' }), { status: 200 });
      return new Response(JSON.stringify({ Success: true, Data: '[{"account_object_id":"g1"}]', CustomData: '{"LastSyncTime":"2026-10-15T08:00:00"}' }), { status: 200 });
    });
    const c = new MisaClient({ appId: APP, accessCode: 'access-code-xyz-123456', companyCode: 'congty' }, fetchFn as never);
    await expect(c.dictionary(1, 0, null)).resolves.toEqual({ rows: [{ account_object_id: 'g1' }], last_sync_time: '2026-10-15T08:00:00' });
    expect(calls[0].url).toBe('https://actapp.misa.vn/api/oauth/actopen/connect');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ app_id: APP, access_code: 'access-code-xyz-123456', org_company_code: 'congty' });
    expect(calls[1].url).toBe('https://actapp.misa.vn/apir/sync/actopen/get_dictionary');
    expect((calls[1].init.headers as Record<string, string>)['X-MISA-AccessToken']).toBe('tok-1');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ app_id: APP, data_type: 1, skip: 0, take: 100, last_sync_time: null });
  });
});

describe('MisaService', () => {
  it('máy chủ chưa đặt MISA_APP_ID ⇒ báo rõ, không gọi MISA', async () => {
    const prev = process.env.MISA_APP_ID;
    delete process.env.MISA_APP_ID;
    const fetchFn = jest.fn();
    const svc = new MisaService({} as never, {} as never, {} as never);
    expect(svc.configured()).toBe(false);
    await expect(svc.connect({ access_code: 'x'.repeat(20), company_code: 'congty' }, 1, fetchFn as never)).rejects.toThrow('MISA_APP_ID');
    expect(fetchFn).not.toHaveBeenCalled();
    if (prev !== undefined) process.env.MISA_APP_ID = prev;
  });
});

describe('MisaService.runSync — bản ghi đã xoá', () => {
  it('get_dictionary_delete ⇒ đánh dấu removed theo id', async () => {
    process.env.MISA_APP_ID = APP;
    const fetchFn = jest.fn(async (url: string) => {
      if (url.endsWith('/connect')) return new Response(JSON.stringify({ Success: true, Data: { access_token: 't' } }), { status: 200 });
      if (url.endsWith('/get_dictionary_delete')) return new Response(JSON.stringify({ Success: true, Data: [{ account_object_id: 'g9' }], CustomData: { LastSyncTime: 'X' } }), { status: 200 });
      return new Response(JSON.stringify({ Success: true, Data: [] }), { status: 200 });
    });
    const prisma = { connectorAccount: { update: jest.fn(), findUnique: jest.fn().mockResolvedValue({ connected_by: 1 }) }, user: { findUnique: jest.fn().mockResolvedValue({ id: 1, team_id: null }) } };
    const sync = { upsertCustomer: jest.fn(), upsertProduct: jest.fn(), markRemoved: jest.fn() };
    const svc = new MisaService(prisma as never, { touch: jest.fn() } as never, sync as never);
    jest.spyOn(svc as never, 'creds' as never).mockResolvedValue({ accessCode: 'x'.repeat(20), settings: { company_code: 'congty' } } as never);
    await svc.runSync(fetchFn as never);
    expect(sync.markRemoved).toHaveBeenCalledWith('misa', 'congty', 'customer', 'g9');
    expect(prisma.connectorAccount.update.mock.calls[0][0].data.settings.del_cursors).toEqual({ customers: 'X', items: 'X' });
    delete process.env.MISA_APP_ID;
  });
});
