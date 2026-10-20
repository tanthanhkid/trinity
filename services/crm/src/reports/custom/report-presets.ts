import type { ReportDef } from './report-def';

/**
 * Bộ báo cáo mẫu cài sẵn (#25) — CHỈ LÀ DỮ LIỆU, không có mã riêng ngành. Mỗi mẫu khai bảng nguồn và danh sách
 * khoá bảng + khoá trường ỨNG VIÊN theo thứ tự ưu tiên; lúc cài, service đối chiếu với danh mục trường thật của bảng:
 * ngày lấy ứng viên đầu tiên có thật (không có ⇒ ngày tạo), cột tổng/nhóm lấy những ứng viên có thật.
 * Không có bảng ứng viên nào ⇒ bỏ báo cáo đó. Thêm ngành mới = thêm một phần tử vào `REPORT_PRESETS`.
 */

export interface PresetReport {
  id: string;
  name: string;
  /** Bảng nguồn ứng viên theo thứ tự ưu tiên (tổ chức đặt khoá bảng khác nhau: `hoc_sinh` / `hoc_vien`). */
  sources: string[];
  date: string[];
  sums?: string[];
  group?: string[];
}

export interface ReportPreset {
  key: string;
  name: string;
  description: string;
  reports: PresetReport[];
}

export const REPORT_PRESETS: readonly ReportPreset[] = [
  {
    key: 'crm_co_ban',
    name: 'CRM cơ bản',
    description: 'Khách hàng mới theo nguồn, deal theo trạng thái và doanh số chốt theo người phụ trách.',
    reports: [
      { id: 'khach_moi_theo_nguon', name: 'Khách hàng mới theo nguồn', sources: ['contacts'], date: ['created_at'], group: ['source_id'] },
      { id: 'deal_theo_trang_thai', name: 'Deal theo trạng thái', sources: ['deals'], date: ['created_at'], sums: ['value'], group: ['status'] },
      { id: 'doanh_so_chot', name: 'Doanh số chốt theo người phụ trách', sources: ['deals'], date: ['won_at'], sums: ['value'], group: ['assigned_to'] },
    ],
  },
  {
    key: 'giao_duc',
    name: 'Trung tâm giáo dục',
    description: 'Phụ huynh, học sinh mới; ghi danh theo loại (mới / tái ký) và theo khoá; thu tiền theo phương thức.',
    reports: [
      { id: 'phu_huynh_moi', name: 'Phụ huynh mới', sources: ['x:phu_huynh', 'x:phu_huynh_hoc_sinh'], date: ['created_at'] },
      { id: 'hoc_sinh_moi', name: 'Học sinh mới', sources: ['x:hoc_sinh', 'x:hoc_vien'], date: ['created_at'], group: ['tinh_trang_hoc', 'trang_thai', 'tinh_trang'] },
      { id: 'ghi_danh_theo_loai', name: 'Ghi danh theo loại', sources: ['x:ghi_danh', 'x:dang_ky_hoc'], date: ['bat_dau', 'ngay_ghi_danh', 'ngay_bat_dau'], group: ['loai_ghi_danh', 'trang_thai'] },
      { id: 'ghi_danh_theo_khoa', name: 'Ghi danh theo khoá học', sources: ['x:ghi_danh', 'x:dang_ky_hoc'], date: ['bat_dau', 'ngay_ghi_danh', 'ngay_bat_dau'], group: ['khoa_hoc'] },
      { id: 'thu_tien', name: 'Thu tiền', sources: ['x:thanh_toan', 'x:thu_tien', 'x:phieu_thu'], date: ['ngay_thanh_toan', 'ngay_tt'], sums: ['so_tien'], group: ['phuong_thuc', 'hinh_thuc', 'phuong_thuc_thanh_toan'] },
      { id: 'hoa_don', name: 'Hoá đơn', sources: ['x:hoa_don'], date: ['ngay_lap'], sums: ['so_tien'], group: ['trang_thai'] },
    ],
  },
];

/** Đối chiếu một báo cáo mẫu với danh mục trường thật của bảng (`has(key, role)`). */
export function resolvePresetReport(
  p: PresetReport,
  presetKey: string,
  source: string,
  has: (key: string, role: 'date' | 'number' | 'group') => boolean,
): ReportDef {
  return {
    id: p.id,
    name: p.name,
    source,
    date_field: p.date.find((k) => has(k, 'date')) ?? 'created_at',
    sum_fields: (p.sums ?? []).filter((k) => has(k, 'number')),
    group_by: (p.group ?? []).find((k) => has(k, 'group')) ?? null,
    preset: presetKey,
  };
}
