import { getStoreSettingsTool, updateStoreSettingsTool } from '../tools/store-tools';

const SETTINGS = { slug: 'cua-hang-abc', name: 'ABC', tagline: null, theme: 'toi-gian', accent: '#2563eb', phone: null, address: null, cover_url: null, logo_url: null, cod: true, bank_transfer: true, bank_bin: '970422', bank_account: '0123456789', bank_account_name: 'ABC', bank_notice: null, published: false, product_ids: [1], owner_user_id: 1 };

function ctx(over: Record<string, unknown> = {}, enabled = true) {
  const store = { settings: jest.fn().mockResolvedValue(SETTINGS), saveSettings: jest.fn().mockImplementation(async (i: Record<string, unknown>) => ({ ...SETTINGS, ...i })), ...over };
  return { store, c: { deps: { store, orgFeatures: { isEnabled: jest.fn().mockResolvedValue(enabled) } }, principal: { userId: 7 }, baseUrl: 'https://crm.example.com' } as never };
}

describe('tool trang bán hàng', () => {
  it('get_store_settings: cấu hình + tài khoản ngân hàng + danh sách ngân hàng; tính năng tắt ⇒ lỗi rõ', async () => {
    const { c } = ctx();
    const out = (await getStoreSettingsTool.run({}, c)).structured.data as Record<string, unknown>;
    expect(out).toMatchObject({ slug: 'cua-hang-abc', bank_transfer_ready: true, bank_name: 'MBBank' }); // số TK qua wrapData bị che như SĐT
    expect((out.banks as Array<{ bin: string }>).some((b) => b.bin === '970436')).toBe(true);
    await expect(getStoreSettingsTool.run({}, ctx({}, false).c)).rejects.toThrow('đang tắt');
  });

  it('update_store_settings: ghi ngay trường thường; mở bán cần confirmed_by_user', async () => {
    const a = ctx();
    await updateStoreSettingsTool.run({ bank_bin: 'Vietcombank', bank_account: '1012345678' }, a.c);
    expect(a.store.saveSettings).toHaveBeenCalledWith({ bank_bin: 'Vietcombank', bank_account: '1012345678' }, 7);
    const b = ctx();
    await expect(updateStoreSettingsTool.run({ published: true }, b.c)).rejects.toThrow('confirmed_by_user');
    expect(b.store.saveSettings).not.toHaveBeenCalled();
    await updateStoreSettingsTool.run({ published: true, confirmed_by_user: 'ok mở bán đi' }, b.c);
    expect(b.store.saveSettings).toHaveBeenCalledWith({ published: true }, 7);
    await expect(updateStoreSettingsTool.run({}, b.c)).rejects.toThrow('Chưa có trường');
  });
});
