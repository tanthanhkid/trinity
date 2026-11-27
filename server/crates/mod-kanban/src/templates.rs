//! Board mẫu (`common/kanban-templates.ts`): hằng số thuần.

pub struct TemplateColumn {
    pub name: &'static str,
    pub is_done: bool,
}

pub struct Template {
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub columns: &'static [TemplateColumn],
}

const fn col(name: &'static str, is_done: bool) -> TemplateColumn {
    TemplateColumn { name, is_done }
}

pub const TEMPLATES: &[Template] = &[
    Template {
        key: "sales",
        name: "Bán hàng",
        description: "Theo dõi cơ hội bán hàng từ khi tiếp cận tới khi chốt/thua.",
        columns: &[
            col("Mới", false),
            col("Đã liên hệ", false),
            col("Báo giá", false),
            col("Chốt", true),
            col("Thua", true),
        ],
    },
    Template {
        key: "customer_care",
        name: "Chăm sóc khách hàng",
        description: "Theo dõi yêu cầu/phản hồi của khách hàng từ khi tiếp nhận tới khi xử lý xong.",
        columns: &[
            col("Mới", false),
            col("Đang xử lý", false),
            col("Chờ phản hồi khách", false),
            col("Đã xử lý", true),
        ],
    },
    Template {
        key: "internal_work",
        name: "Công việc nội bộ",
        description: "Quản lý công việc nội bộ theo quy trình Cần làm → Đang làm → Chờ duyệt → Xong.",
        columns: &[
            col("Cần làm", false),
            col("Đang làm", false),
            col("Chờ duyệt", false),
            col("Xong", true),
        ],
    },
];

pub fn find(key: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.key == key)
}
