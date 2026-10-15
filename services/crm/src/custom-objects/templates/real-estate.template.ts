import type { CustomObjectTemplate, SampleRecord, TemplateField } from './template-types';

/** Mẫu "Bất động sản" Dự án, Sản phẩm/căn, Giữ chỗ/đặt cọc, Lịch dẫn khách. Giá/m² và tiền cọc tính bằng công thức. */
const c = (value: string, label: string, color?: string) => ({ value, label, ...(color ? { color } : {}) });
const pad = (n: number) => String(n).padStart(2, '0');

const projectFields: TemplateField[] = [
  { key: 'ten_du_an', label: 'Tên dự án', type: 'text', required: true, is_title: true },
  { key: 'chu_dau_tu', label: 'Chủ đầu tư', type: 'text' },
  { key: 'dia_chi', label: 'Địa chỉ', type: 'text' },
  { key: 'loai_hinh', label: 'Loại hình', type: 'select', choices: [c('can_ho', 'Căn hộ', 'blue'), c('nha_pho', 'Nhà phố', 'amber'), c('biet_thu', 'Biệt thự', 'purple'), c('dat_nen', 'Đất nền', 'green')] },
  { key: 'trang_thai', label: 'Tình trạng', type: 'select', choices: [c('sap_mo_ban', 'Sắp mở bán', 'amber'), c('dang_ban', 'Đang bán', 'green'), c('ngung_ban', 'Ngưng bán', 'gray')] },
  { key: 'ngay_mo_ban', label: 'Ngày mở bán', type: 'date' },
  { key: 'ghi_chu', label: 'Ghi chú', type: 'long_text', show_in_list: false },
];

const unitFields: TemplateField[] = [
  { key: 'ma_can', label: 'Mã căn', type: 'text', required: true, is_unique: true, is_title: true },
  { key: 'du_an', label: 'Dự án', type: 'relation', relation: 'bds_du_an', required: true },
  { key: 'dien_tich', label: 'Diện tích (m²)', type: 'number', required: true },
  { key: 'so_phong_ngu', label: 'Số phòng ngủ', type: 'number' },
  { key: 'huong', label: 'Hướng', type: 'select', choices: [c('dong', 'Đông'), c('tay', 'Tây'), c('nam', 'Nam'), c('bac', 'Bắc'), c('dong_nam', 'Đông Nam'), c('tay_bac', 'Tây Bắc')] },
  { key: 'gia_ban', label: 'Giá bán', type: 'currency', required: true },
  { key: 'gia_m2', label: 'Giá / m²', type: 'formula', expression: 'round({gia_ban}/{dien_tich}, 0)', format: 'currency' },
  { key: 'trang_thai', label: 'Trạng thái', type: 'select', choices: [c('con_trong', 'Còn trống', 'green'), c('giu_cho', 'Giữ chỗ', 'amber'), c('da_coc', 'Đã đặt cọc', 'blue'), c('da_ban', 'Đã bán', 'gray')] },
];

const reservationFields: TemplateField[] = [
  { key: 'ma_giu_cho', label: 'Mã giữ chỗ', type: 'text', required: true, is_unique: true, is_title: true },
  { key: 'khach_hang', label: 'Khách hàng', type: 'relation', relation: 'contact' },
  { key: 'san_pham', label: 'Căn / sản phẩm', type: 'relation', relation: 'bds_san_pham', required: true },
  { key: 'loai', label: 'Loại', type: 'select', choices: [c('giu_cho', 'Giữ chỗ', 'amber'), c('dat_coc', 'Đặt cọc', 'blue')] },
  { key: 'gia_ban', label: 'Giá chốt', type: 'currency' },
  { key: 'ty_le_coc', label: 'Tỷ lệ cọc (%)', type: 'percent' },
  { key: 'tien_coc', label: 'Tiền cọc', type: 'formula', expression: '{gia_ban}*{ty_le_coc}', format: 'currency' },
  { key: 'ngay_coc', label: 'Ngày giữ chỗ / cọc', type: 'date' },
  { key: 'han_coc', label: 'Hạn giữ chỗ', type: 'date' },
  { key: 'trang_thai', label: 'Trạng thái', type: 'select', choices: [c('hieu_luc', 'Còn hiệu lực', 'green'), c('chuyen_hop_dong', 'Đã chuyển hợp đồng', 'indigo'), c('het_han', 'Hết hạn', 'gray'), c('huy', 'Đã huỷ', 'red')] },
];

const viewingFields: TemplateField[] = [
  { key: 'ma_lich', label: 'Mã lịch', type: 'text', required: true, is_unique: true, is_title: true },
  { key: 'khach_hang', label: 'Khách hàng', type: 'relation', relation: 'contact' },
  { key: 'du_an', label: 'Dự án', type: 'relation', relation: 'bds_du_an' },
  { key: 'san_pham', label: 'Căn xem', type: 'relation', relation: 'bds_san_pham' },
  { key: 'ngay_hen', label: 'Ngày hẹn', type: 'datetime' },
  { key: 'nhan_vien', label: 'Nhân viên dẫn', type: 'user' },
  { key: 'trang_thai', label: 'Trạng thái', type: 'select', choices: [c('da_hen', 'Đã hẹn', 'blue'), c('da_di', 'Đã dẫn xem', 'green'), c('khach_huy', 'Khách huỷ', 'gray'), c('khong_den', 'Khách không đến', 'red')] },
  { key: 'phan_hoi', label: 'Phản hồi của khách', type: 'long_text', show_in_list: false },
];

function sampleRecords(today: string): SampleRecord[] {
  const out: SampleRecord[] = [];
  for (let i = 1; i <= 2; i++) out.push({ object: 'bds_du_an', data: { ten_du_an: `Dự án Mẫu ${pad(i)}`, chu_dau_tu: `Chủ đầu tư Mẫu ${pad(i)}`, dia_chi: `Địa chỉ mẫu ${pad(i)}`, loai_hinh: i === 1 ? 'can_ho' : 'nha_pho', trang_thai: 'dang_ban', ngay_mo_ban: today } });
  const units = [[65, 3_250_000_000, 'con_trong'], [82, 4_510_000_000, 'giu_cho'], [120, 7_800_000_000, 'da_coc'], [95, 5_700_000_000, 'con_trong']] as const;
  units.forEach(([dt, gia, tt], i) =>
    out.push({ object: 'bds_san_pham', data: { ma_can: `A-${pad(i + 1)}${pad(i + 1)}`, dien_tich: dt, so_phong_ngu: i % 3 + 1, huong: ['dong', 'nam', 'dong_nam', 'tay_bac'][i], gia_ban: gia, trang_thai: tt }, refs: { du_an: i < 2 ? 0 : 1 } }));
  out.push({ object: 'bds_giu_cho', data: { ma_giu_cho: 'GC-MAU-01', loai: 'giu_cho', gia_ban: 4_510_000_000, ty_le_coc: 2, ngay_coc: today, trang_thai: 'hieu_luc' }, refs: { san_pham: 1 } });
  out.push({ object: 'bds_giu_cho', data: { ma_giu_cho: 'GC-MAU-02', loai: 'dat_coc', gia_ban: 7_800_000_000, ty_le_coc: 10, ngay_coc: today, trang_thai: 'hieu_luc' }, refs: { san_pham: 2 } });
  out.push({ object: 'bds_lich_dan', data: { ma_lich: 'LD-MAU-01', ngay_hen: `${today}T09:00:00+07:00`, trang_thai: 'da_hen' }, refs: { du_an: 0, san_pham: 0 } });
  out.push({ object: 'bds_lich_dan', data: { ma_lich: 'LD-MAU-02', ngay_hen: `${today}T15:30:00`, trang_thai: 'da_hen' }, refs: { du_an: 1, san_pham: 3 } });
  return out;
}

export const REAL_ESTATE_TEMPLATE: CustomObjectTemplate = {
  key: 'real_estate',
  label: 'Bất động sản',
  description: 'Dự án, Sản phẩm/căn (giá/m² tự tính), Giữ chỗ/đặt cọc (tiền cọc tự tính), Lịch dẫn khách.',
  objects: [
    { key: 'bds_du_an', label: 'Dự án', label_plural: 'Dự án', icon: 'building-2', description: 'Dự án bất động sản đang phân phối', fields: projectFields },
    { key: 'bds_san_pham', label: 'Sản phẩm / căn', label_plural: 'Sản phẩm / căn', icon: 'home', description: 'Từng căn: mã căn, diện tích, giá, trạng thái', fields: unitFields },
    { key: 'bds_giu_cho', label: 'Giữ chỗ / đặt cọc', label_plural: 'Giữ chỗ / đặt cọc', icon: 'clipboard-list', description: 'Giữ chỗ và đặt cọc căn cho khách', fields: reservationFields },
    { key: 'bds_lich_dan', label: 'Lịch dẫn khách', label_plural: 'Lịch dẫn khách', icon: 'calendar-check', description: 'Lịch hẹn dẫn khách đi xem dự án / căn', fields: viewingFields },
  ],
  samples: sampleRecords,
};
