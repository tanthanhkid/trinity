import type { CustomObjectTemplate, SampleRecord, TemplateField } from './template-types';

/** Mẫu "Phòng khám (nha khoa / thú y)" Bệnh nhân / thú cưng, Lịch hẹn, Điều trị (tổng chi phí tự tính). */
const c = (value: string, label: string, color?: string) => ({ value, label, ...(color ? { color } : {}) });
const pad = (n: number) => String(n).padStart(2, '0');

const patientFields: TemplateField[] = [
  { key: 'ten', label: 'Tên bệnh nhân / thú cưng', type: 'text', required: true, is_title: true },
  { key: 'loai', label: 'Đối tượng', type: 'select', choices: [c('nguoi', 'Người', 'blue'), c('cho', 'Chó', 'amber'), c('meo', 'Mèo', 'purple'), c('khac', 'Khác', 'gray')] },
  { key: 'chu_nuoi', label: 'Chủ nuôi / người liên hệ', type: 'relation', relation: 'contact', help_text: 'Chọn từ Danh bạ' },
  { key: 'gioi_tinh', label: 'Giới tính', type: 'select', choices: [c('duc_nam', 'Đực / Nam', 'blue'), c('cai_nu', 'Cái / Nữ', 'pink')] },
  { key: 'ngay_sinh', label: 'Ngày sinh', type: 'date' },
  { key: 'can_nang', label: 'Cân nặng (kg)', type: 'number' },
  { key: 'tien_su', label: 'Tiền sử / dị ứng', type: 'long_text', show_in_list: false },
];

const appointmentFields: TemplateField[] = [
  { key: 'ma_hen', label: 'Mã lịch hẹn', type: 'text', required: true, is_unique: true, is_title: true },
  { key: 'benh_nhan', label: 'Bệnh nhân / thú cưng', type: 'relation', relation: 'pk_benh_nhan', required: true },
  { key: 'thoi_gian', label: 'Thời gian hẹn', type: 'datetime', required: true },
  { key: 'dich_vu', label: 'Dịch vụ', type: 'select', choices: [c('kham', 'Khám tổng quát', 'blue'), c('tai_kham', 'Tái khám', 'teal'), c('tiem_phong', 'Tiêm phòng', 'green'), c('dieu_tri', 'Điều trị', 'amber'), c('lay_cao', 'Lấy cao răng / vệ sinh', 'purple')] },
  { key: 'bac_si', label: 'Bác sĩ phụ trách', type: 'user' },
  { key: 'trang_thai', label: 'Trạng thái', type: 'select', choices: [c('da_hen', 'Đã hẹn', 'blue'), c('da_den', 'Đã đến', 'green'), c('hoan_thanh', 'Hoàn thành', 'indigo'), c('huy', 'Huỷ', 'gray'), c('vang_mat', 'Không đến', 'red')] },
  { key: 'ghi_chu', label: 'Ghi chú', type: 'long_text', show_in_list: false },
];

const treatmentFields: TemplateField[] = [
  { key: 'ma_dieu_tri', label: 'Mã điều trị', type: 'text', required: true, is_unique: true, is_title: true },
  { key: 'benh_nhan', label: 'Bệnh nhân / thú cưng', type: 'relation', relation: 'pk_benh_nhan', required: true },
  { key: 'lich_hen', label: 'Lịch hẹn', type: 'relation', relation: 'pk_lich_hen' },
  { key: 'chan_doan', label: 'Chẩn đoán', type: 'text' },
  { key: 'phac_do', label: 'Phác đồ / thủ thuật', type: 'long_text', show_in_list: false },
  { key: 'chi_phi_thu_thuat', label: 'Chi phí thủ thuật', type: 'currency' },
  { key: 'chi_phi_thuoc', label: 'Chi phí thuốc', type: 'currency' },
  { key: 'tong_chi_phi', label: 'Tổng chi phí', type: 'formula', expression: '{chi_phi_thu_thuat}+{chi_phi_thuoc}', format: 'currency' },
  { key: 'ngay_dieu_tri', label: 'Ngày điều trị', type: 'date' },
  { key: 'ngay_tai_kham', label: 'Ngày tái khám', type: 'date' },
  { key: 'trang_thai', label: 'Trạng thái', type: 'select', choices: [c('dang_dieu_tri', 'Đang điều trị', 'amber'), c('hoan_thanh', 'Hoàn thành', 'green'), c('theo_doi', 'Theo dõi', 'blue')] },
];

function sampleRecords(today: string): SampleRecord[] {
  const out: SampleRecord[] = [];
  const pts = [['Bệnh nhân Mẫu 01', 'nguoi'], ['Thú cưng Mẫu 01', 'cho'], ['Thú cưng Mẫu 02', 'meo']] as const;
  pts.forEach(([ten, loai], i) => out.push({ object: 'pk_benh_nhan', data: { ten, loai, gioi_tinh: i % 2 ? 'cai_nu' : 'duc_nam', can_nang: [60, 12, 4][i] } }));
  const services = ['lay_cao', 'tiem_phong', 'kham'];
  for (let i = 0; i < 3; i++) out.push({ object: 'pk_lich_hen', data: { ma_hen: `LH-MAU-${pad(i + 1)}`, thoi_gian: `${today}T${pad(9 + i)}:00:00+07:00`, dich_vu: services[i], trang_thai: 'da_hen' }, refs: { benh_nhan: i } });
  for (let i = 0; i < 2; i++) out.push({ object: 'pk_dieu_tri', data: { ma_dieu_tri: `DT-MAU-${pad(i + 1)}`, chan_doan: `Chẩn đoán mẫu ${pad(i + 1)}`, chi_phi_thu_thuat: [500_000, 350_000][i], chi_phi_thuoc: [120_000, 80_000][i], ngay_dieu_tri: today, trang_thai: i ? 'hoan_thanh' : 'dang_dieu_tri' }, refs: { benh_nhan: i, lich_hen: i } });
  return out;
}

export const CLINIC_TEMPLATE: CustomObjectTemplate = {
  key: 'clinic',
  label: 'Phòng khám (nha khoa / thú y)',
  description: 'Bệnh nhân / thú cưng, Lịch hẹn, Điều trị (tổng chi phí tự tính).',
  objects: [
    { key: 'pk_benh_nhan', label: 'Bệnh nhân / thú cưng', label_plural: 'Bệnh nhân / thú cưng', icon: 'heart-pulse', description: 'Hồ sơ bệnh nhân hoặc thú cưng và chủ nuôi', fields: patientFields },
    { key: 'pk_lich_hen', label: 'Lịch hẹn', label_plural: 'Lịch hẹn', icon: 'calendar-check', description: 'Lịch hẹn khám, tiêm phòng, điều trị', fields: appointmentFields },
    { key: 'pk_dieu_tri', label: 'Điều trị', label_plural: 'Điều trị', icon: 'stethoscope', description: 'Chẩn đoán, phác đồ, chi phí và tái khám', fields: treatmentFields },
  ],
  samples: sampleRecords,
};
