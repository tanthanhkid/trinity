//! Quyết định có gửi sự kiện cho endpoint không và che SĐT theo quyền của CHỦ THỂ endpoint (người tạo, hoặc người sửa URL gần
//! nhất). "Không cấp thứ mình không có": thuần (không I/O), dùng lúc tạo delivery và lúc gửi (quyền có thể đổi giữa chừng).
//! Port của `webhook-payload.ts`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::audit::JS_WS;

/// Kết quả `ScopeService.ownerIds(user, perm)`: mọi owner, một danh sách owner, hoặc không có quyền.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Scope {
    All,
    Owners(Vec<i32>),
    #[default]
    None,
}

impl Scope {
    fn allows(&self, owners: &[Option<i32>]) -> bool {
        match self {
            Self::All => true,
            Self::Owners(ids) => owners.iter().flatten().any(|o| ids.contains(o)),
            Self::None => false,
        }
    }
}

/// Phạm vi xem và quyền SĐT của chủ thể, tính một lần cho mỗi vòng gửi.
#[derive(Debug, Clone, Default)]
pub struct ActorScopes {
    pub contacts_view: Scope,
    pub deals_view: Scope,
    pub pos_sell: Scope,
    pub phone_full: Scope,
    pub custom_view: Scope,
    pub custom_phone_full: Scope,
    pub role_ids: Vec<i32>,
    pub can_manage_custom_objects: bool,
    pub can_social_post: bool,
}

type Obj = Map<String, Value>;

fn digit_run() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(&format!(r"\+?[0-9(][0-9{JS_WS}.\-()/_]{{7,}}[0-9]")).expect("regex hợp lệ"))
}

fn already_masked(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("***") else {
        return false;
    };
    rest.len() <= 3 && rest.bytes().all(|b| b.is_ascii_digit())
}

/// `0900000168` thành `***168`; ≤ 3 chữ số thành `***`.
pub fn mask_phone(phone: &str) -> String {
    let d: Vec<char> = phone.chars().filter(char::is_ascii_digit).collect();
    if d.len() <= 3 {
        "***".to_owned()
    } else {
        format!("***{}", d[d.len() - 3..].iter().collect::<String>())
    }
}

/// Che SĐT; giữ nguyên chuỗi đã che (idempotent: chạy lại lúc gửi không làm méo).
fn mask_value(v: &mut Value) {
    if let Value::String(s) = v
        && !s.is_empty()
        && !already_masked(s)
    {
        *s = mask_phone(s);
    }
}

/// Văn bản tự do hay bị dán SĐT vào ⇒ che mọi dãy từ 9 chữ số.
pub fn scrub_digit_runs(text: &str) -> String {
    digit_run()
        .replace_all(text, |c: &regex::Captures<'_>| {
            let m = &c[0];
            let digits: Vec<char> = m.chars().filter(char::is_ascii_digit).collect();
            if digits.len() >= 9 {
                format!("***{}", digits[digits.len() - 3..].iter().collect::<String>())
            } else {
                m.to_owned()
            }
        })
        .into_owned()
}

fn scrub_fields(o: &mut Obj, fields: &[&str]) {
    for f in fields {
        if let Some(Value::String(s)) = o.get_mut(*f) {
            *s = scrub_digit_runs(s);
        }
    }
}

fn looks_like_phone(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if s.chars().filter(char::is_ascii_digit).count() >= 8)
}

fn mask_contact(c: &mut Obj) {
    for k in ["phone", "phone_2"] {
        if let Some(v) = c.get_mut(k) {
            mask_value(v);
        }
    }
    if looks_like_phone(c.get("zalo_account"))
        && let Some(v) = c.get_mut("zalo_account")
    {
        mask_value(v);
    }
    scrub_fields(c, &["full_name", "email"]);
}

fn num(v: Option<&Value>) -> Option<i32> {
    v.and_then(Value::as_i64).and_then(|n| i32::try_from(n).ok())
}

fn obj<'a>(data: &'a mut Obj, k: &str) -> Option<&'a mut Obj> {
    data.get_mut(k).and_then(Value::as_object_mut)
}

fn evaluate_custom_record(data: &mut Obj, s: &ActorScopes) -> bool {
    let (Some(o), Some(r)) = (
        data.get("object").and_then(Value::as_object),
        data.get("record").and_then(Value::as_object),
    ) else {
        return false;
    };
    let roles: Vec<i32> = o
        .get("visible_role_ids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| num(Some(x))).collect())
        .unwrap_or_default();
    if !s.can_manage_custom_objects {
        if o.get("is_active") == Some(&Value::Bool(false)) {
            return false;
        }
        if !roles.is_empty() && !roles.iter().any(|r| s.role_ids.contains(r)) {
            return false;
        }
    }
    let owners = [num(r.get("owner_id")), num(r.get("created_by"))];
    if !s.custom_view.allows(&owners) {
        return false;
    }
    if !s.custom_phone_full.allows(&owners) {
        let phone_keys: Vec<String> = r
            .get("phone_fields")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        if let Some(rec) = obj(data, "record") {
            if let Some(rd) = rec.get_mut("data").and_then(Value::as_object_mut) {
                for (k, v) in rd.iter_mut() {
                    if phone_keys.contains(k) {
                        mask_value(v);
                    } else if let Value::String(t) = v {
                        *t = scrub_digit_runs(t);
                    }
                }
            }
            scrub_fields(rec, &["title"]);
        }
    }
    true
}

/// `Some(payload đã che)` nếu nên gửi, `None` nếu bỏ qua (không lỗi, không tự nới quyền). Loại lạ ⇒ `None`.
pub fn evaluate_event(event_type: &str, payload: &Value, s: &ActorScopes) -> Option<Value> {
    let mut root = match payload {
        Value::Object(o) => o.clone(),
        _ => Obj::new(),
    };
    let data = &mut root;
    let deliver = if event_type.starts_with("contact.") {
        let c = data.get("contact").and_then(Value::as_object);
        let mut owners = vec![
            num(c.and_then(|c| c.get("assigned_to"))),
            num(c.and_then(|c| c.get("created_by_id"))),
        ];
        if event_type == "contact.assigned" {
            owners.push(num(data.get("from_user_id")));
            owners.push(num(data.get("to_user_id")));
        }
        if !s.contacts_view.allows(&owners) {
            return None;
        }
        if !s.phone_full.allows(&owners) {
            if let Some(c) = obj(data, "contact") {
                mask_contact(c);
            }
            scrub_fields(data, &["reason"]);
        }
        true
    } else if event_type.starts_with("deal.") {
        let d = data.get("deal").and_then(Value::as_object);
        let owners = [
            num(d.and_then(|d| d.get("assigned_to"))),
            num(d.and_then(|d| d.get("created_by"))),
        ];
        if !s.deals_view.allows(&owners) {
            return None;
        }
        if !s.phone_full.allows(&owners)
            && let Some(d) = obj(data, "deal")
        {
            scrub_fields(d, &["title", "description", "note"]);
        }
        true
    } else if event_type == "pos.order.completed" {
        let o = data.get("order").and_then(Value::as_object);
        let owners = [
            num(o.and_then(|o| o.get("created_by"))),
            num(o.and_then(|o| o.get("paid_by"))),
        ];
        if !s.pos_sell.allows(&owners) {
            return None;
        }
        if !s.phone_full.allows(&owners)
            && let Some(o) = obj(data, "order")
        {
            scrub_fields(o, &["note"]);
            if let Some(Value::Array(ps)) = o.get_mut("payments") {
                for p in ps.iter_mut().filter_map(Value::as_object_mut) {
                    scrub_fields(p, &["reference"]);
                }
            }
        }
        true
    } else if event_type.starts_with("custom_record.") {
        evaluate_custom_record(data, s)
    } else if event_type.starts_with("zalo_oa.")
        || event_type.starts_with("messenger.message_")
        || event_type == "facebook.comment_received"
    {
        s.contacts_view.allows(&[num(data.get("contact_assigned_to"))])
    } else if event_type == "messenger.broadcast_finished" {
        if s.phone_full != Scope::All {
            scrub_fields(data, &["name"]);
        }
        true
    } else if event_type.starts_with("social_post.") {
        s.can_social_post
    } else if event_type == "payment.received" {
        true
    } else if matches!(
        event_type,
        "store_order.created" | "store_order.paid" | "store_order.status_changed"
    ) {
        let o = data.get("order").and_then(Value::as_object);
        let owners = [num(o.and_then(|o| o.get("contact_assigned_to")))];
        if !s.deals_view.allows(&owners) {
            return None;
        }
        if !s.phone_full.allows(&owners)
            && let Some(o) = obj(data, "order")
        {
            if let Some(v) = o.get_mut("customer_phone") {
                mask_value(v);
            }
            scrub_fields(o, &["customer_name", "customer_address", "note"]);
        }
        true
    } else {
        false
    };
    deliver.then(|| Value::Object(root))
}
