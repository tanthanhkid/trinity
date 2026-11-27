//! Bộ báo cáo mẫu cài sẵn (`reports/custom/report-presets.ts`): CHỈ LÀ DỮ LIỆU, không có mã riêng ngành. Mỗi mẫu khai bảng nguồn và
//! danh sách khoá bảng + khoá trường ỨNG VIÊN theo thứ tự ưu tiên; lúc cài, service đối chiếu với danh mục trường thật của bảng.

use crate::custom_def::ReportDef;
use crate::custom_sources::Role;

pub struct PresetReport {
    pub id: &'static str,
    pub name: &'static str,
    /// Bảng nguồn ứng viên theo thứ tự ưu tiên (tổ chức đặt khoá bảng khác nhau: `hoc_sinh` / `hoc_vien`).
    pub sources: &'static [&'static str],
    pub date: &'static [&'static str],
    pub sums: &'static [&'static str],
    pub group: &'static [&'static str],
}

pub struct Preset {
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub reports: &'static [PresetReport],
}

const fn r(
    id: &'static str,
    name: &'static str,
    sources: &'static [&'static str],
    date: &'static [&'static str],
    sums: &'static [&'static str],
    group: &'static [&'static str],
) -> PresetReport {
    PresetReport {
        id,
        name,
        sources,
        date,
        sums,
        group,
    }
}

const ENROLL_SRC: &[&str] = &["x:ghi_danh", "x:dang_ky_hoc"];
const ENROLL_DATE: &[&str] = &["bat_dau", "ngay_ghi_danh", "ngay_bat_dau"];

pub const PRESETS: &[Preset] = &[
    Preset {
        key: "crm_co_ban",
        name: "CRM cơ bản",
        description: "Khách hàng mới theo nguồn, deal theo trạng thái và doanh số chốt theo người phụ trách.",
        reports: &[
            r(
                "khach_moi_theo_nguon",
                "Khách hàng mới theo nguồn",
                &["contacts"],
                &["created_at"],
                &[],
                &["source_id"],
            ),
            r(
                "deal_theo_trang_thai",
                "Deal theo trạng thái",
                &["deals"],
                &["created_at"],
                &["value"],
                &["status"],
            ),
            r(
                "doanh_so_chot",
                "Doanh số chốt theo người phụ trách",
                &["deals"],
                &["won_at"],
                &["value"],
                &["assigned_to"],
            ),
        ],
    },
    Preset {
        key: "giao_duc",
        name: "Trung tâm giáo dục",
        description: "Phụ huynh, học sinh mới; ghi danh theo loại (mới / tái ký) và theo khoá; thu tiền theo phương thức.",
        reports: &[
            r(
                "phu_huynh_moi",
                "Phụ huynh mới",
                &["x:phu_huynh", "x:phu_huynh_hoc_sinh"],
                &["created_at"],
                &[],
                &[],
            ),
            r(
                "hoc_sinh_moi",
                "Học sinh mới",
                &["x:hoc_sinh", "x:hoc_vien"],
                &["created_at"],
                &[],
                &["tinh_trang_hoc", "trang_thai", "tinh_trang"],
            ),
            r(
                "ghi_danh_theo_loai",
                "Ghi danh theo loại",
                ENROLL_SRC,
                ENROLL_DATE,
                &[],
                &["loai_ghi_danh", "trang_thai"],
            ),
            r(
                "ghi_danh_theo_khoa",
                "Ghi danh theo khoá học",
                ENROLL_SRC,
                ENROLL_DATE,
                &[],
                &["khoa_hoc"],
            ),
            r(
                "thu_tien",
                "Thu tiền",
                &["x:thanh_toan", "x:thu_tien", "x:phieu_thu"],
                &["ngay_thanh_toan", "ngay_tt"],
                &["so_tien"],
                &["phuong_thuc", "hinh_thuc", "phuong_thuc_thanh_toan"],
            ),
            r(
                "hoa_don",
                "Hoá đơn",
                &["x:hoa_don"],
                &["ngay_lap"],
                &["so_tien"],
                &["trang_thai"],
            ),
        ],
    },
];

/// `resolvePresetReport`: đối chiếu một báo cáo mẫu với danh mục trường thật của bảng (`has(key, role)`).
pub fn resolve_report(p: &PresetReport, preset_key: &str, source: &str, has: impl Fn(&str, Role) -> bool) -> ReportDef {
    ReportDef {
        id: p.id.to_owned(),
        name: p.name.to_owned(),
        source: source.to_owned(),
        date_field: p
            .date
            .iter()
            .find(|k| has(k, Role::Date))
            .map_or("created_at", |k| k)
            .to_owned(),
        sum_fields: p
            .sums
            .iter()
            .filter(|k| has(k, Role::Number))
            .map(|k| (*k).to_owned())
            .collect(),
        group_by: p.group.iter().find(|k| has(k, Role::Group)).map(|k| (*k).to_owned()),
        preset: Some(preset_key.to_owned()),
    }
}
