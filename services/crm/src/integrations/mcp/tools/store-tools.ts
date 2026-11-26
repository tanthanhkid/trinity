import { BadRequestException, ConflictException } from '@nestjs/common';
import { wrapData } from '../ai-output';
import { isUserConfirmation } from '../actions/user-confirmation';
import { STORE_BANKS, STORE_THEMES, bankAccountOf, type StoreSettings } from '../../../store/store.service';
import { ToolUserError, type McpDeps, type ToolDef } from './tool-types';

const MANAGE = '/connections?muc=ban-online';

async function storeDeps(deps: Pick<McpDeps, 'store' | 'orgFeatures'>) {
  if (!deps.store) throw new ToolUserError('Máy chủ này chưa có trang bán hàng. / The online store is not available on this server.');
  if (!(await deps.orgFeatures.isEnabled('online_store'))) {
    throw new ToolUserError('Tính năng "Trang bán hàng" đang tắt (Cài đặt › Tính năng). / The Online store feature is turned off for this workspace.');
  }
  return deps.store;
}

function storeForAi(s: StoreSettings) {
  const bank = bankAccountOf(s);
  return {
    name: s.name,
    slug: s.slug,
    page_path: s.slug ? `/s/${s.slug}` : null,
    published: s.published,
    tagline: s.tagline,
    theme: s.theme,
    accent: s.accent,
    phone: s.phone,
    address: s.address,
    cover_url: s.cover_url,
    logo_url: s.logo_url,
    cod: s.cod,
    bank_transfer: s.bank_transfer,
    /** Chuyển khoản đang thật sự nhận được trên trang (bật + đủ tài khoản). */
    bank_transfer_ready: bank !== null,
    bank_bin: s.bank_bin,
    bank_name: bank?.name ?? STORE_BANKS.find((b) => b.bin === s.bank_bin)?.name ?? null,
    bank_account: s.bank_account,
    bank_account_name: s.bank_account_name,
    bank_notice: s.bank_notice,
    product_ids: s.product_ids,
  };
}

export const getStoreSettingsTool: ToolDef = {
  name: 'get_store_settings',
  title: 'Cấu hình trang bán hàng / Online store settings',
  description:
    'Đọc cấu hình trang bán hàng online của công ty: tên, địa chỉ trang (/s/<slug>), đang mở bán hay chưa, giao diện, cách thanh toán (COD, chuyển khoản bằng QR VietQR), ' +
    'tài khoản ngân hàng nhận tiền, sản phẩm đang bán, và danh sách ngân hàng chọn được (banks: bin + tên). Chuyển khoản không tự khớp tiền: nhân viên đổi đơn sang "đã thanh toán". ' +
    'Chỉ đọc. / Reads the online store settings, including the bank account for VietQR transfers and the list of supported banks. Read-only.',
  permissions: ['pos.manage'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(_args, { deps, baseUrl }) {
    const store = await storeDeps(deps);
    const out = wrapData({ ...storeForAi(await store.settings()), banks: STORE_BANKS, manage_url: `${baseUrl}${MANAGE}` });
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const updateStoreSettingsTool: ToolDef = {
  name: 'update_store_settings',
  title: 'Sửa cấu hình trang bán hàng / Update online store settings',
  description:
    'Sửa cấu hình trang bán hàng: chỉ gửi trường cần đổi. Chuyển khoản: bank_transfer = true kèm bank_bin (mã BIN 6 số hoặc tên ngân hàng trong banks của get_store_settings, vd "MBBank") và bank_account (4–19 chữ số/chữ cái); ' +
    'khách quét QR VietQR do Trinity tự sinh, tiền vào thẳng tài khoản đó. Mở bán (published = true khi đang chưa mở) đưa trang lên công khai nên cần confirmed_by_user là lời người dùng đồng ý, chép nguyên văn; ' +
    `các thay đổi khác ghi ngay. Giao diện: ${STORE_THEMES.join(', ')}. Không có công cụ xoá trang. Cần quyền quản lý bán hàng. / Updates the online store settings; publishing needs the user's confirmation. No delete tool.`,
  permissions: ['pos.manage'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    name: z.string().max(80).optional(),
    slug: z.string().max(40).optional().describe('Địa chỉ trang: chữ thường không dấu, số, gạch ngang / Page address'),
    tagline: z.string().max(120).optional(),
    theme: z.enum(STORE_THEMES).optional(),
    accent: z.string().max(7).optional().describe('#RRGGBB'),
    phone: z.string().max(120).optional(),
    address: z.string().max(200).optional(),
    cover_url: z.string().max(500).optional(),
    logo_url: z.string().max(500).optional(),
    cod: z.boolean().optional(),
    bank_transfer: z.boolean().optional(),
    bank_bin: z.string().max(40).optional().describe('BIN 6 số hoặc tên ngân hàng / Bank BIN or name'),
    bank_account: z.string().max(30).optional(),
    bank_account_name: z.string().max(80).optional(),
    product_ids: z.array(z.number().int().positive()).max(200).optional().describe('Danh sách sản phẩm bán trên trang (thay toàn bộ) / Products on the page (replaces the list)'),
    published: z.boolean().optional(),
    confirmed_by_user: z.string().max(300).optional().describe('Bắt buộc khi mở bán: lời người dùng đồng ý, chép nguyên văn. / Required when publishing.'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal, baseUrl }) {
    const store = await storeDeps(deps);
    const keys = ['name', 'slug', 'tagline', 'theme', 'accent', 'phone', 'address', 'cover_url', 'logo_url', 'cod', 'bank_transfer', 'bank_bin', 'bank_account', 'bank_account_name', 'product_ids', 'published'] as const;
    const input = Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
    if (!Object.keys(input).length) throw new ToolUserError('Chưa có trường nào cần đổi. / Nothing to change.');
    const current = await store.settings();
    if (input.published === true && !current.published && !isUserConfirmation(args.confirmed_by_user)) {
      throw new ToolUserError(
        'Chưa đổi gì: mở bán đưa trang lên công khai cho mọi người. Cho người dùng xem tên, địa chỉ trang, sản phẩm và cách thanh toán rồi gửi lại với confirmed_by_user là lời họ đồng ý. / Nothing changed: publishing needs the user\'s confirmation.',
      );
    }
    try {
      const next = await store.saveSettings(input, principal.userId);
      const out = wrapData({ updated: true, ...storeForAi(next), manage_url: `${baseUrl}${MANAGE}` });
      return { structured: out, text: JSON.stringify(out) };
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ConflictException) throw new ToolUserError(err.message);
      throw err;
    }
  },
};

export const STORE_TOOLS: readonly ToolDef[] = [getStoreSettingsTool, updateStoreSettingsTool];
