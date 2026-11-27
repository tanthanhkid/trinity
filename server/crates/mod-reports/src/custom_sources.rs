//! Danh mục bảng nguồn cho báo cáo dùng chung (`reports/custom/report-sources.ts`): bảng lõi (khách hàng, deal) + mọi bảng tuỳ
//! biến; mỗi bảng khai các trường dùng được theo VAI: `date` (chia kỳ), `number` (cộng tổng), `group` (nhóm). Biểu thức SQL dựng từ
//! khoá trường đã đối chiếu với danh mục (khoá do máy chủ lưu, dạng `[a-z][a-z0-9_]*`) và được escape như literal; KHÔNG BAO GIỜ
//! nội suy chuỗi người dùng gửi.

use mod_custom::access::ObjectDef;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Date,
    Number,
    Group,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Date => "date",
            Self::Number => "number",
            Self::Group => "group",
        }
    }
}

/// Cách đổi giá trị nhóm thô (mã) ra nhãn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Labels {
    Map(Vec<(String, String)>),
    User,
    Option,
    Contact,
    Record(i32),
    Raw,
}

#[derive(Debug, Clone)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub role: Role,
    /// date ⇒ biểu thức kiểu `date` (NULL nếu trống/sai) · number ⇒ `float8` · group ⇒ `text`.
    pub expr: String,
    pub labels: Option<Labels>,
}

#[derive(Debug, Clone)]
pub struct Spec {
    pub source: String,
    pub label: String,
    pub table: &'static str,
    /// Điều kiện nền (bỏ dòng đã xoá, đúng bảng tuỳ biến).
    pub base: String,
    /// Quyền xem (có phạm vi) quyết định dòng nào được đếm: số trên báo cáo khớp danh sách người xem thấy.
    pub scope_perm: &'static str,
    pub owner_cols: Vec<&'static str>,
    pub fields: Vec<Field>,
}

/// Literal chuỗi SQL (nháy đơn gấp đôi).
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn vn_date(col: &str) -> String {
    format!("({col} AT TIME ZONE 'Asia/Ho_Chi_Minh')::date")
}

fn f(key: &str, label: &str, role: Role, expr: String, labels: Option<Labels>) -> Field {
    Field {
        key: key.to_owned(),
        label: label.to_owned(),
        role,
        expr,
        labels,
    }
}

fn map(pairs: &[(&str, &str)]) -> Labels {
    Labels::Map(pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect())
}

/// Bảng lõi: khách hàng và deal.
pub fn core_sources() -> Vec<Spec> {
    let contacts = Spec {
        source: "contacts".into(),
        label: "Khách hàng".into(),
        table: "contacts",
        base: "deleted_at IS NULL".into(),
        scope_perm: "contacts.view",
        owner_cols: vec!["assigned_to", "created_by_id"],
        fields: vec![
            f("created_at", "Ngày tạo", Role::Date, vn_date("created_at"), None),
            f(
                "lead_score",
                "Điểm tiềm năng",
                Role::Number,
                "lead_score::float8".into(),
                None,
            ),
            f(
                "stage_id",
                "Giai đoạn",
                Role::Group,
                "stage_id::text".into(),
                Some(Labels::Option),
            ),
            f(
                "source_id",
                "Nguồn",
                Role::Group,
                "source_id::text".into(),
                Some(Labels::Option),
            ),
            f(
                "contact_status_id",
                "Tình trạng",
                Role::Group,
                "contact_status_id::text".into(),
                Some(Labels::Option),
            ),
            f(
                "assigned_to",
                "Người phụ trách",
                Role::Group,
                "assigned_to::text".into(),
                Some(Labels::User),
            ),
            f(
                "lead_label",
                "Nhãn tiềm năng",
                Role::Group,
                "lead_label".into(),
                Some(map(&[("hot", "Nóng"), ("warm", "Ấm"), ("cold", "Lạnh")])),
            ),
        ],
    };
    let deals = Spec {
        source: "deals".into(),
        label: "Deal".into(),
        table: "deals",
        base: "TRUE".into(),
        scope_perm: "deals.view",
        owner_cols: vec!["assigned_to", "created_by"],
        fields: vec![
            f("created_at", "Ngày tạo", Role::Date, vn_date("created_at"), None),
            f("won_at", "Ngày chốt thắng", Role::Date, vn_date("won_at"), None),
            f("value", "Giá trị", Role::Number, "value::float8".into(), None),
            f(
                "status",
                "Trạng thái",
                Role::Group,
                "status".into(),
                Some(map(&[("open", "Đang mở"), ("won", "Thắng"), ("lost", "Thua")])),
            ),
            f(
                "assigned_to",
                "Người phụ trách",
                Role::Group,
                "assigned_to::text".into(),
                Some(Labels::User),
            ),
        ],
    };
    vec![contacts, deals]
}

const YMD: &str = "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])";
const NUM: &str = "^-?[0-9]+(\\.[0-9]+)?$";

fn safe_key(k: &str) -> bool {
    let mut it = k.chars();
    it.next().is_some_and(|c| c.is_ascii_lowercase())
        && it.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Bảng tuỳ biến → nguồn báo cáo: ngày tạo/cập nhật + trường date/datetime; số/tiền/%; lựa chọn/người dùng/liên kết đơn.
pub fn custom_source(def: &ObjectDef) -> Spec {
    let mut fields = vec![
        f("created_at", "Ngày tạo", Role::Date, vn_date("created_at"), None),
        f("updated_at", "Ngày cập nhật", Role::Date, vn_date("updated_at"), None),
    ];
    for fd in def.fields.iter().filter(|x| safe_key(&x.key)) {
        let txt = format!("(data->>{})", lit(&fd.key));
        let opts = &fd.options;
        match fd.kind.as_str() {
            "date" => fields.push(f(
                &fd.key,
                &fd.label,
                Role::Date,
                format!("CASE WHEN {txt} ~ {} THEN {txt}::date END", lit(&format!("{YMD}$"))),
                None,
            )),
            "datetime" => fields.push(f(
                &fd.key,
                &fd.label,
                Role::Date,
                format!(
                    "CASE WHEN {txt} ~ {} THEN ({txt}::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date END",
                    lit(&format!("{YMD}T"))
                ),
                None,
            )),
            "number" | "currency" | "percent" => fields.push(f(
                &fd.key,
                &fd.label,
                Role::Number,
                format!("CASE WHEN {txt} ~ {} THEN {txt}::float8 END", lit(NUM)),
                None,
            )),
            "select" => {
                let pairs = opts
                    .get("choices")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|c| {
                                Some((
                                    c.get("value")?.as_str()?.to_owned(),
                                    c.get("label")?.as_str()?.to_owned(),
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                fields.push(f(&fd.key, &fd.label, Role::Group, txt, Some(Labels::Map(pairs))));
            }
            "user" => fields.push(f(&fd.key, &fd.label, Role::Group, txt, Some(Labels::User))),
            "relation" if !truthy(opts.get("multiple")) => {
                let target_id = opts
                    .get("target_object_id")
                    .and_then(Value::as_i64)
                    .filter(|n| *n != 0)
                    .and_then(|n| i32::try_from(n).ok());
                let labels = if opts.get("target").and_then(Value::as_str) == Some("contact") {
                    Some(Labels::Contact)
                } else {
                    target_id.map(Labels::Record)
                };
                if let Some(l) = labels {
                    fields.push(f(&fd.key, &fd.label, Role::Group, txt, Some(l)));
                }
            }
            _ => {}
        }
    }
    Spec {
        source: format!("x:{}", def.obj.key),
        label: def.obj.label_plural.clone(),
        table: "custom_records",
        base: format!("object_id = {} AND deleted_at IS NULL", def.obj.id),
        scope_perm: "custom_records.view",
        owner_cols: vec!["owner_id", "created_by"],
        fields,
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

pub fn find_field<'a>(spec: &'a Spec, key: &str, role: Role) -> Option<&'a Field> {
    spec.fields.iter().find(|f| f.key == key && f.role == role)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_va_vai_tro() {
        assert_eq!(lit("a'b"), "'a''b'");
        let core = core_sources();
        assert_eq!(
            core.iter().map(|s| s.source.as_str()).collect::<Vec<_>>(),
            ["contacts", "deals"]
        );
        assert!(find_field(&core[1], "won_at", Role::Date).is_some());
        assert!(find_field(&core[1], "won_at", Role::Number).is_none());
        assert_eq!(core[0].fields.iter().filter(|f| f.role == Role::Group).count(), 5);
        assert!(safe_key("so_tien") && !safe_key("Tien") && !safe_key("a'b") && !safe_key(""));
    }
}
