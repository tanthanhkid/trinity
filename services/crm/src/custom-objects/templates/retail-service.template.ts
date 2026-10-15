import type { CustomObjectTemplate, SampleRecord, TemplateField } from './template-types';

/** Mẫu "Bán lẻ / dịch vụ" Sản phẩm/dịch vụ, Đơn hàng, Khách thân thiết (hạng, điểm). */
const c = (value: string, label: string, color?: string) => ({ value, label, ...(color ? { color } : {}) });
const pad = (n: number) => String(n).padStart(2, '0');

const productFields: TemplateField[] = [
  { key: 'ten', label: 'Tên sản phẩm / dịch vụ', type: 'text', required: true, is_title: true },
  { key: 'ma_sku', label: 'Mã SKU', type: 'text', is_unique: true },
  { key: 'loai', label: 'Loại', type: 'select', choices: [c('san_pham', 'Sản phẩm', 'blue'), c('dich_vu', 'Dịch vụ', 'purple')] },
  { key: 'gia_ban', label: 'Giá bán', type: 'currency', required: true },
  { key: 'gia_von', label: 'Giá vốn', type: 'currency' },
  { key: 'loi_nhuan', label: 'Lãi gộp', type: 'formula', expression: '{gia_ban}-{gia_von}', format: 'currency' },
  { key: 'ton_kho', label: 'Tồn kho', type: 'number', help_text: 'Bỏ trống nếu là dịch vụ' },
  { key: 'dang_ban', label: 'Đang kinh doanh', type: 'boolean' },
];

const loyaltyFields: TemplateField[] = [
  { key: 'ho_ten', label: 'Họ tên khách', type: 'text', required: true, is_title: true },
  { key: 'khach_hang', label: 'Liên hệ trong Danh bạ', type: 'relation', relation: 'contact' },
  { key: 'hang', label: 'Hạng', type: 'select', choices: [c('thuong', 'Thường', 'gray'), c('bac', 'Bạc', 'blue'), c('vang', 'Vàng', 'amber'), c('kim_cuong', 'Kim cương', 'purple')] },
  { key: 'diem', label: 'Điểm tích luỹ', type: 'number' },
  { key: 'tong_chi_tieu', label: 'Tổng chi tiêu', type: 'currency' },
  { key: 'ngay_tham_gia', label: 'Ngày tham gia', type: 'date' },
  { key: 'lan_mua_cuoi', label: 'Lần mua gần nhất', type: 'date' },
];

const orderFields: TemplateField[] = [
  { key: 'ma_don', label: 'Mã đơn', type: 'text', required: true, is_unique: true, is_title: true },
  { key: 'khach', label: 'Khách thân thiết', type: 'relation', relation: 'bl_khach_than_thiet' },
  { key: 'san_pham', label: 'Sản phẩm / dịch vụ', type: 'relation', relation: 'bl_san_pham', required: true },
  { key: 'so_luong', label: 'Số lượng', type: 'number', required: true },
  { key: 'don_gia', label: 'Đơn giá', type: 'currency', required: true },
  { key: 'giam_gia', label: 'Giảm giá (%)', type: 'percent', help_text: 'Nhập 0 nếu không giảm (để trống thì thành tiền rỗng)' },
  { key: 'thanh_tien', label: 'Thành tiền', type: 'formula', expression: '{so_luong}*{don_gia}*(1-{giam_gia})', format: 'currency' },
  { key: 'ngay_dat', label: 'Ngày đặt', type: 'date' },
  { key: 'thanh_toan', label: 'Thanh toán', type: 'select', choices: [c('tien_mat', 'Tiền mặt'), c('chuyen_khoan', 'Chuyển khoản'), c('the', 'Thẻ'), c('vi_dien_tu', 'Ví điện tử')] },
  { key: 'trang_thai', label: 'Trạng thái', type: 'select', choices: [c('moi', 'Mới', 'blue'), c('dang_giao', 'Đang giao', 'amber'), c('hoan_thanh', 'Hoàn thành', 'green'), c('da_huy', 'Đã huỷ', 'gray')] },
];

function sampleRecords(today: string): SampleRecord[] {
  const out: SampleRecord[] = [];
  const products = [['Sản phẩm Mẫu 01', 'san_pham', 250_000, 150_000, 40], ['Sản phẩm Mẫu 02', 'san_pham', 480_000, 300_000, 15], ['Dịch vụ Mẫu 01', 'dich_vu', 600_000, 200_000, null]] as const;
  products.forEach(([ten, loai, gia, von, ton], i) => out.push({ object: 'bl_san_pham', data: { ten, ma_sku: `SKU-MAU-${pad(i + 1)}`, loai, gia_ban: gia, gia_von: von, ...(ton === null ? {} : { ton_kho: ton }), dang_ban: true } }));
  const tiers = [['thuong', 120], ['bac', 850], ['vang', 2400]] as const;
  tiers.forEach(([hang, diem], i) => out.push({ object: 'bl_khach_than_thiet', data: { ho_ten: `Khách Mẫu ${pad(i + 1)}`, hang, diem, tong_chi_tieu: diem * 10_000, ngay_tham_gia: today, lan_mua_cuoi: today } }));
  for (let i = 0; i < 3; i++) out.push({ object: 'bl_don_hang', data: { ma_don: `DH-MAU-${pad(i + 1)}`, so_luong: i + 1, don_gia: products[i][2], giam_gia: i === 2 ? 10 : 0, ngay_dat: today, thanh_toan: i === 1 ? 'chuyen_khoan' : 'tien_mat', trang_thai: i === 0 ? 'hoan_thanh' : 'moi' }, refs: { khach: i, san_pham: i } });
  return out;
}

export const RETAIL_SERVICE_TEMPLATE: CustomObjectTemplate = {
  key: 'retail_service',
  label: 'Bán lẻ / dịch vụ',
  description: 'Sản phẩm/dịch vụ (lãi gộp tự tính), Đơn hàng (thành tiền tự tính), Khách thân thiết (hạng, điểm).',
  objects: [
    { key: 'bl_san_pham', label: 'Sản phẩm / dịch vụ', label_plural: 'Sản phẩm / dịch vụ', icon: 'package', description: 'Danh mục sản phẩm, dịch vụ: giá bán, giá vốn, tồn kho', fields: productFields },
    { key: 'bl_khach_than_thiet', label: 'Khách thân thiết', label_plural: 'Khách thân thiết', icon: 'star', description: 'Khách thành viên: hạng, điểm tích luỹ, chi tiêu', fields: loyaltyFields },
    { key: 'bl_don_hang', label: 'Đơn hàng', label_plural: 'Đơn hàng', icon: 'shopping-cart', description: 'Đơn bán hàng / dịch vụ', fields: orderFields },
  ],
  samples: sampleRecords,
};
