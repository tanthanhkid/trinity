//! Lọc dữ liệu riêng tư cho sự kiện Sentry — bản Rust của `apps/monolith/src/monitoring-filters.ts`: xoá mọi thứ có
//! thể chứa dữ liệu khách hàng trước khi sự kiện rời tiến trình. Hàm thuần, chạy trên JSON của sự kiện nên kiểm được
//! không cần SDK.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::redact_url;

#[allow(clippy::expect_used)]
static EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+").expect("regex email"));
// Dãy >= 8 chữ số, cho phép `+`, khoảng trắng, chấm, gạch, ngoặc xen giữa. Hai nhánh đầu (IPv4, ngày ISO kèm giờ
// tuỳ chọn) khớp trước để giữ nguyên, rồi duyệt tiếp phần sau: `2026-11-26 0912345678` vẫn che số điện thoại.
#[allow(clippy::expect_used)]
static PHONE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?P<keep>[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2})?)?)|(?P<ph>\+?[0-9][0-9\s().-]{6,}[0-9])",
    )
    .expect("regex phone")
});

/// Che email và số điện thoại trong văn bản.
pub fn scrub_text(text: &str) -> String {
    let t = EMAIL_RE.replace_all(text, "[email]");
    PHONE_RE
        .replace_all(&t, |c: &regex::Captures<'_>| {
            let m = &c[0];
            if c.name("keep").is_some() {
                return m.to_owned();
            }
            if m.chars().filter(char::is_ascii_digit).count() >= 8 {
                "[phone]".to_owned()
            } else {
                m.to_owned()
            }
        })
        .into_owned()
}

/// Che token trong đường dẫn/query rồi bỏ hẳn query string và fragment.
pub fn scrub_url(url: &str) -> String {
    let redacted = redact_url(url);
    redacted.split(['?', '#']).next().unwrap_or("").to_owned()
}

const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

fn scrub_str_field(obj: &mut Map<String, Value>, key: &str, f: impl Fn(&str) -> String) {
    if let Some(Value::String(s)) = obj.get_mut(key) {
        *s = f(s);
    }
}

/// Mảng phần tử của trường kiểu `[..]` (SDK Node) hoặc `{"values":[..]}` (giao thức Sentry/Rust).
fn items_mut(v: &mut Value) -> Option<&mut Vec<Value>> {
    match v {
        Value::Array(a) => Some(a),
        Value::Object(o) => o.get_mut("values").and_then(Value::as_array_mut),
        _ => None,
    }
}

fn scrub_breadcrumbs(crumbs: &mut Value) {
    let Some(list) = items_mut(crumbs) else { return };
    list.retain(|b| b.get("category").and_then(Value::as_str) != Some("console"));
    for b in list {
        let Some(o) = b.as_object_mut() else { continue };
        if let Some(Value::Object(d)) = o.get_mut("data") {
            scrub_str_field(d, "url", scrub_url);
        }
        scrub_str_field(o, "message", scrub_text);
    }
}

/// Lọc một sự kiện (JSON): bỏ `request.{data,cookies,headers,query_string}` và `extra`, đưa `user` về chỉ còn `id`
/// (đã băm), che email/số điện thoại trong message, exception, breadcrumb, tag, đường dẫn trong URL/transaction/span.
pub fn scrub_event(event: &mut Value) {
    let Some(ev) = event.as_object_mut() else { return };
    if let Some(Value::Object(r)) = ev.get_mut("request") {
        for k in ["data", "cookies", "headers", "query_string", "env"] {
            r.remove(k);
        }
        scrub_str_field(r, "url", |u| scrub_text(&scrub_url(u)));
    }
    // `extra` là chỗ mã gọi nhét dữ liệu tự do: bỏ hết (an toàn hơn che từng khoá). `contexts` do SDK tự sinh (hệ
    // điều hành, runtime) nên giữ; mã gọi không được đặt context riêng chứa dữ liệu khách.
    ev.remove("extra");
    if let Some(Value::Object(u)) = ev.get_mut("user") {
        let id = match u.get("id") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        };
        u.clear();
        if let Some(id) = id {
            u.insert("id".to_owned(), Value::String(id));
        }
    }
    scrub_str_field(ev, "message", scrub_text);
    if let Some(Value::Object(l)) = ev.get_mut("logentry") {
        scrub_str_field(l, "message", scrub_text);
        l.remove("params");
    }
    if let Some(exc) = ev.get_mut("exception").and_then(items_mut) {
        for v in exc {
            if let Some(o) = v.as_object_mut() {
                scrub_str_field(o, "value", scrub_text);
                // Biến cục bộ trong stacktrace có thể chứa dữ liệu khách.
                if let Some(frames) = o
                    .get_mut("stacktrace")
                    .and_then(|s| s.get_mut("frames"))
                    .and_then(Value::as_array_mut)
                {
                    for f in frames {
                        if let Some(fo) = f.as_object_mut() {
                            fo.remove("vars");
                        }
                    }
                }
            }
        }
    }
    if let Some(b) = ev.get_mut("breadcrumbs") {
        scrub_breadcrumbs(b);
    }
    if let Some(Value::Object(tags)) = ev.get_mut("tags") {
        for v in tags.values_mut() {
            if let Value::String(s) = v {
                *s = scrub_text(s);
            }
        }
    }
    if let Some(Value::String(t)) = ev.get_mut("transaction")
        && let Some((method, rest)) = t.split_once(' ')
        && METHODS.contains(&method)
    {
        *t = format!("{method} {}", scrub_text(&scrub_url(rest)));
    }
    if let Some(Value::Array(spans)) = ev.get_mut("spans") {
        for s in spans {
            let Some(o) = s.as_object_mut() else { continue };
            scrub_str_field(o, "description", |d| scrub_text(&scrub_url(d)));
            if let Some(Value::Object(d)) = o.get_mut("data") {
                for k in ["url", "http.url", "url.full", "http.target"] {
                    scrub_str_field(d, k, scrub_url);
                }
                for k in ["http.query", "url.query"] {
                    if d.contains_key(k) {
                        d.insert(k.to_owned(), Value::String(String::new()));
                    }
                }
            }
        }
    }
}

/// Lọc sự kiện Sentry của SDK. `None` (bỏ sự kiện) nếu không chuyển đổi được: thà mất sự kiện còn hơn gửi bản chưa lọc.
pub fn scrub_sentry_event(event: sentry::protocol::Event<'static>) -> Option<sentry::protocol::Event<'static>> {
    // trinity-lint: allow-json-value (sự kiện Sentry rời tiến trình, không phải model/cột DB)
    let mut v = serde_json::to_value(&event).ok()?;
    scrub_event(&mut v);
    serde_json::from_value(v).ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn che_email_va_so_dien_thoai() {
        assert_eq!(scrub_text("gửi tới a.b+c@x.com.vn rồi"), "gửi tới [email] rồi");
        assert_eq!(
            scrub_text("gọi 0912 345 678 hoặc +84 (912) 345-678."),
            "gọi [phone] hoặc [phone]."
        );
        assert_eq!(scrub_text("lỗi 1234567 dòng 10"), "lỗi 1234567 dòng 10");
        assert_eq!(scrub_text("không có gì"), "không có gì");
        // Ngày, giờ, IP không phải số điện thoại; số điện thoại đứng cạnh vẫn bị che.
        assert_eq!(
            scrub_text("lúc 2026-11-26 13:27:34 từ 192.168.100.200"),
            "lúc 2026-11-26 13:27:34 từ 192.168.100.200"
        );
        assert_eq!(scrub_text("2026-11-26 0912345678"), "2026-11-26 [phone]");
        assert_eq!(
            scrub_text("2026-11-26T13:27 gọi 0912 345 678"),
            "2026-11-26T13:27 gọi [phone]"
        );
    }

    #[test]
    fn url_bo_query_va_token() {
        assert_eq!(scrub_url("/api/v1/x?token=abc&email=a@b.co#f"), "/api/v1/x");
        assert_eq!(scrub_url("/hooks/in/secrettoken/run?x=1"), "/hooks/in/[redacted]/run");
    }

    #[test]
    fn su_kien_khong_con_body_cookie_email_so_dien_thoai() {
        let mut ev = json!({
            "request": {"url": "https://h/a/b?email=a@b.co&token=t", "data": {"phone": "0912345678"},
                        "cookies": "sid=1", "headers": {"authorization": "Bearer x"}, "query_string": "q=1"},
            "user": {"id": 42, "email": "u@x.vn", "ip_address": "1.2.3.4", "username": "bob"},
            "message": "khách 0912345678 lỗi",
            "logentry": {"message": "mail u@x.vn", "params": ["u@x.vn"]},
            "extra": {"body": "secret"},
            "tags": {"k": "u@x.vn"},
            "exception": {"values": [{"value": "bad 0912345678", "stacktrace": {"frames": [{"function": "f", "vars": {"a": "u@x.vn"}}]}}]},
            "breadcrumbs": {"values": [
                {"category": "console", "message": "noise"},
                {"category": "http", "message": "to u@x.vn", "data": {"url": "/x?a=b@c.de"}}]},
            "transaction": "GET /orders/0912345678?phone=1",
            "spans": [{"description": "GET /x?email=a@b.co", "data": {"url": "/x?a=1", "http.query": "a=1"}}]
        });
        scrub_event(&mut ev);
        let s = ev.to_string();
        for leak in [
            "a@b.co",
            "u@x.vn",
            "0912345678",
            "sid=1",
            "Bearer",
            "1.2.3.4",
            "bob",
            "secret",
            "noise",
            "b@c.de",
        ] {
            assert!(!s.contains(leak), "{leak} còn trong {s}");
        }
        assert_eq!(ev["user"], json!({"id": "42"}));
        assert_eq!(ev["request"]["url"], "https://h/a/b");
        assert_eq!(ev["transaction"], "GET /orders/[phone]");
        assert_eq!(ev["breadcrumbs"]["values"].as_array().map(Vec::len), Some(1));
        assert_eq!(ev["spans"][0]["data"]["http.query"], "");
    }

    #[test]
    fn breadcrumbs_dang_mang_cua_sdk_node() {
        let mut ev = json!({"breadcrumbs": [{"category": "console"}, {"message": "u@x.vn"}]});
        scrub_event(&mut ev);
        assert_eq!(ev["breadcrumbs"], json!([{"message": "[email]"}]));
    }
}
