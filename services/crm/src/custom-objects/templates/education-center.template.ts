import type { CustomObjectTemplate, SampleRecord, TemplateField } from './template-types';

/**
 * Mẫu "Trung tâm giáo dục": Phụ huynh, Học sinh, Khoá học / Gói học phí, Hoá đơn,
 * Ghi danh, Thanh toán.
 *
 * Công thức KHÔNG tham chiếu công thức khác (BE cấm) nên mỗi cột tính viết lại từ trường gốc:
 *   Thanh toán = Giá gốc × (1 − Ưu đãi) · Giá giới thiệu = Thanh toán × 0,9 · Giá nhóm = Thanh toán × 0,8 ·
 *   Đơn giá/buổi = Thanh toán ÷ Số buổi · Thực tế (tháng) = làm tròn 1 số lẻ của số tháng từ Bắt đầu đến Kết thúc.
 */
const c = (value: string, label: string, color?: string) => ({ value, label, ...(color ? { color } : {}) });
const NET = '{gia_goc}*(1-{uu_dai})';

const parentFields: TemplateField[] = [
  { key: 'ho_ten', label: 'Họ và tên phụ huynh', type: 'text', required: true, is_title: true },
  { key: 'sdt', label: 'Số điện thoại', type: 'phone' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'ghi_chu', label: 'Ghi chú', type: 'long_text', show_in_list: false },
];

const studentFields: TemplateField[] = [
  { key: 'ho_ten', label: 'Họ và tên học sinh', type: 'text', required: true, is_title: true },
  { key: 'tuoi', label: 'Tuổi', type: 'number' },
  { key: 'gioi_tinh', label: 'Giới tính', type: 'select', choices: [c('nam', 'Nam', 'blue'), c('nu', 'Nữ', 'pink')] },
  { key: 'phu_huynh', label: 'Phụ huynh', type: 'relation', relation: 'phu_huynh' },
  {
    key: 'tinh_trang_hoc', label: 'Tình trạng học', type: 'select',
    choices: [c('dang_hoc', 'Đang học', 'green'), c('tam_nghi', 'Tạm nghỉ', 'amber'), c('khong_co_nhu_cau', 'Không có nhu cầu', 'gray'), c('da_ket_thuc', 'Đã kết thúc', 'indigo')],
  },
  { key: 'ma_he_thong', label: 'Id hệ thống', type: 'text', help_text: 'Mã học sinh ở hệ thống ngoài (nếu có)', show_in_list: false },
  { key: 'ghi_chu', label: 'Ghi chú', type: 'long_text', show_in_list: false },
];

const courseFields: TemplateField[] = [
  { key: 'ten_goi', label: 'Tên gói', type: 'text', required: true, is_title: true },
  { key: 'thoi_han_thang', label: 'Thời hạn (tháng)', type: 'number' },
  { key: 'so_buoi', label: 'Số buổi', type: 'number', required: true },
  { key: 'gia_goc', label: 'Giá gốc', type: 'currency', required: true },
  { key: 'uu_dai', label: 'Ưu đãi (%)', type: 'percent', required: true, help_text: 'Nhập 5 = ưu đãi 5%; nhập 0 nếu không ưu đãi (để trống thì các cột giá tính ra rỗng)' },
  { key: 'thanh_toan', label: 'Thanh toán', type: 'formula', expression: NET, format: 'currency' },
  { key: 'gia_gioi_thieu', label: 'Giá giới thiệu', type: 'formula', expression: `${NET}*0.9`, format: 'currency' },
  { key: 'gia_nhom', label: 'Giá nhóm', type: 'formula', expression: `${NET}*0.8`, format: 'currency' },
  { key: 'don_gia_buoi', label: 'Đơn giá / buổi', type: 'formula', expression: `round(${NET}/{so_buoi}, 0)`, format: 'currency' },
];

const invoiceFields: TemplateField[] = [
  { key: 'ma_hoa_don', label: 'Mã hoá đơn', type: 'text', required: true, is_unique: true, is_title: true },
  { key: 'phu_huynh', label: 'Phụ huynh', type: 'relation', relation: 'phu_huynh' },
  { key: 'hoc_sinh', label: 'Học sinh', type: 'relation', relation: 'hoc_sinh' },
  { key: 'khoa_hoc', label: 'Khoá học / Gói', type: 'relation', relation: 'khoa_hoc' },
  { key: 'muc_gia', label: 'Mức giá áp dụng', type: 'select', choices: [c('gia_thanh_toan', 'Giá thanh toán'), c('gia_gioi_thieu', 'Giá giới thiệu'), c('gia_nhom', 'Giá nhóm')] },
  { key: 'so_tien', label: 'Số tiền', type: 'currency' },
  { key: 'ngay_lap', label: 'Ngày lập', type: 'date' },
  {
    key: 'trang_thai', label: 'Trạng thái', type: 'select',
    choices: [c('chua_thanh_toan', 'Chưa thanh toán', 'amber'), c('da_thanh_toan', 'Đã thanh toán', 'green'), c('da_huy', 'Đã huỷ', 'gray')],
  },
];

const enrollmentFields: TemplateField[] = [
  { key: 'ma_ghi_danh', label: 'Mã ghi danh', type: 'text', required: true, is_unique: true, is_title: true },
  { key: 'hoc_sinh', label: 'Học sinh', type: 'relation', relation: 'hoc_sinh', required: true },
  { key: 'khoa_hoc', label: 'Khoá học / Gói', type: 'relation', relation: 'khoa_hoc' },
  { key: 'so_buoi_tuan', label: 'Số buổi / tuần', type: 'select', choices: [c('1', '1 buổi / tuần'), c('2', '2 buổi / tuần')] },
  { key: 'thoi_han_thang', label: 'Thời hạn gói (tháng)', type: 'number' },
  {
    key: 'trang_thai', label: 'Trạng thái', type: 'select',
    choices: [c('dang_hoc', 'Đang học', 'green'), c('hoan_thanh', 'Hoàn thành', 'indigo'), c('tam_dung', 'Tạm dừng', 'amber'), c('da_huy', 'Đã huỷ', 'gray')],
  },
  { key: 'bat_dau', label: 'Bắt đầu', type: 'date' },
  { key: 'ket_thuc', label: 'Kết thúc', type: 'date' },
  { key: 'thuc_te_thang', label: 'Thực tế (tháng)', type: 'formula', expression: 'round(months_between({bat_dau}, {ket_thuc}), 1)', format: 'number', decimals: 1 },
  { key: 'hoa_don', label: 'Mã hoá đơn', type: 'relation', relation: 'hoa_don' },
];

const paymentFields: TemplateField[] = [
  { key: 'ma_thanh_toan', label: 'Mã thanh toán', type: 'text', required: true, is_unique: true, is_title: true },
  { key: 'hoa_don', label: 'Hoá đơn', type: 'relation', relation: 'hoa_don' },
  { key: 'phu_huynh', label: 'Phụ huynh', type: 'relation', relation: 'phu_huynh' },
  { key: 'hoc_sinh', label: 'Học sinh', type: 'relation', relation: 'hoc_sinh' },
  { key: 'so_tien', label: 'Số tiền', type: 'currency', required: true },
  { key: 'ngay_thanh_toan', label: 'Ngày thanh toán', type: 'date' },
  { key: 'phuong_thuc', label: 'Phương thức', type: 'select', choices: [c('chuyen_khoan', 'Chuyển khoản'), c('tien_mat', 'Tiền mặt'), c('the', 'Thẻ'), c('vi_dien_tu', 'Ví điện tử')] },
  {
    key: 'trang_thai', label: 'Trạng thái', type: 'select',
    choices: [c('da_thanh_toan', 'Đã thanh toán', 'green'), c('cho_xac_nhan', 'Chờ xác nhận', 'amber'), c('chua_thanh_toan', 'Chưa thanh toán', 'gray'), c('hoan_tien', 'Hoàn tiền', 'red')],
  },
  { key: 'ghi_chu', label: 'Ghi chú', type: 'long_text', show_in_list: false },
];

/** 4 gói học phí mẫu (giá giả, số tròn). */
const PACKAGES = [
  { ten_goi: 'Gói THÁNG', thoi_han_thang: 1, so_buoi: 8, gia_goc: 3_000_000, uu_dai: 0 },
  { ten_goi: 'Gói QUÝ (3 tháng)', thoi_han_thang: 3, so_buoi: 24, gia_goc: 9_000_000, uu_dai: 5 },
  { ten_goi: 'Gói HỌC KỲ (6 tháng)', thoi_han_thang: 6, so_buoi: 48, gia_goc: 18_000_000, uu_dai: 10 },
  { ten_goi: 'Gói NĂM (1 cấp độ)', thoi_han_thang: 12, so_buoi: 96, gia_goc: 36_000_000, uu_dai: 15 },
].map(({ ten_goi, thoi_han_thang, so_buoi, gia_goc, uu_dai }) => ({ ten_goi, thoi_han_thang, so_buoi, gia_goc, uu_dai }));

const pad = (n: number) => String(n).padStart(2, '0');
const phone = (n: number) => `0900000${String(n).padStart(3, '0')}`;

/** Dữ liệu mẫu GIẢ: tên "… Mẫu NN", SĐT 0900000xxx, email example.invalid. Liên kết bằng chỉ số trong cùng mẫu. */
function sampleRecords(today: string): SampleRecord[] {
  const out: SampleRecord[] = [];
  for (let i = 1; i <= 3; i++) out.push({ object: 'phu_huynh', data: { ho_ten: `Phụ huynh Mẫu ${pad(i)}`, sdt: phone(i), email: `phuhuynh${pad(i)}@example.invalid` } });
  for (let i = 1; i <= 4; i++) {
    out.push({
      object: 'hoc_sinh',
      data: { ho_ten: `Học sinh Mẫu ${pad(i)}`, tuoi: 6 + i, gioi_tinh: i % 2 ? 'nam' : 'nu', tinh_trang_hoc: i === 4 ? 'tam_nghi' : 'dang_hoc' },
      refs: { phu_huynh: (i - 1) % 3 },
    });
  }
  for (const p of PACKAGES) out.push({ object: 'khoa_hoc', data: { ...p } });
  for (let i = 1; i <= 3; i++) {
    const pkg = PACKAGES[i];
    out.push({
      object: 'hoa_don',
      data: { ma_hoa_don: `HD-MAU-${String(i).padStart(3, '0')}`, muc_gia: 'gia_thanh_toan', so_tien: Math.round(pkg.gia_goc * (1 - pkg.uu_dai / 100)), ngay_lap: today, trang_thai: i === 1 ? 'da_thanh_toan' : 'chua_thanh_toan' },
      refs: { phu_huynh: i - 1, hoc_sinh: i - 1, khoa_hoc: i },
    });
  }
  for (let i = 1; i <= 3; i++) {
    out.push({
      object: 'ghi_danh',
      data: { ma_ghi_danh: `GD-MAU-${String(i).padStart(3, '0')}`, so_buoi_tuan: i === 2 ? '2' : '1', thoi_han_thang: PACKAGES[i].thoi_han_thang, trang_thai: 'dang_hoc', bat_dau: today, ket_thuc: addMonths(today, PACKAGES[i].thoi_han_thang) },
      refs: { hoc_sinh: i - 1, khoa_hoc: i, hoa_don: i - 1 },
    });
  }
  for (let i = 1; i <= 3; i++) {
    out.push({
      object: 'thanh_toan',
      data: { ma_thanh_toan: `TT-MAU-${String(i).padStart(3, '0')}`, so_tien: Math.round(PACKAGES[i].gia_goc * (1 - PACKAGES[i].uu_dai / 100)), ngay_thanh_toan: today, phuong_thuc: i === 2 ? 'tien_mat' : 'chuyen_khoan', trang_thai: i === 1 ? 'da_thanh_toan' : 'cho_xac_nhan' },
      refs: { hoa_don: i - 1, phu_huynh: i - 1, hoc_sinh: i - 1 },
    });
  }
  return out;
}

function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(Math.min(d, last))}`;
}

export const EDUCATION_CENTER_TEMPLATE: CustomObjectTemplate = {
  key: 'education_center',
  label: 'Trung tâm giáo dục',
  description: 'Phụ huynh, Học sinh, Khoá học / Gói học phí, Hoá đơn, Ghi danh, Thanh toán — đã nối liên kết và công thức.',
  objects: [
    { key: 'phu_huynh', label: 'Phụ huynh', label_plural: 'Phụ huynh', icon: 'users', description: 'Phụ huynh / người giám hộ của học sinh', fields: parentFields },
    { key: 'hoc_sinh', label: 'Học sinh', label_plural: 'Học sinh', icon: 'graduation-cap', description: 'Học sinh và tình trạng học', fields: studentFields },
    { key: 'khoa_hoc', label: 'Khoá học', label_plural: 'Khoá học / Gói', icon: 'book-open', description: 'Gói học phí: giá gốc, ưu đãi, giá thanh toán và đơn giá / buổi', fields: courseFields },
    { key: 'hoa_don', label: 'Hoá đơn', label_plural: 'Hoá đơn', icon: 'receipt', description: 'Hoá đơn học phí theo học sinh và gói', fields: invoiceFields },
    { key: 'ghi_danh', label: 'Ghi danh', label_plural: 'Ghi danh', icon: 'clipboard-list', description: 'Đăng ký học: học sinh, gói, thời gian học thực tế', fields: enrollmentFields },
    { key: 'thanh_toan', label: 'Thanh toán', label_plural: 'Thanh toán', icon: 'wallet', description: 'Các lần thanh toán của hoá đơn', fields: paymentFields },
  ],
  samples: sampleRecords,
};
